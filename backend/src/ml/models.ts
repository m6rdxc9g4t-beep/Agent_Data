// Modèles enregistrés : un modèle retenu à l'entraînement peut être conservé sur disque (DATA_DIR/models/<id>.json),
// réutilisé après un redémarrage dans le simulateur et appliqué à un autre fichier (prédictions par lot).
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { FeatureEncoding, TargetInfo } from './prepare.js'
import { encodeRow } from './prepare.js'
import { forgetModel, predictorOf, recentModel, rememberModel, type Metric, type ModelBody, type Stored } from './train.js'

export interface SavedModelInfo {
  id: string
  name: string
  datasetId: string
  datasetName: string
  target: TargetInfo
  label: string
  metrics: Metric[]
  summary: string
  features: string[]
  simulator: { name: string; kind: FeatureEncoding['kind']; levels?: string[]; default: string | number }[]
  rows: number
  createdAt: string
}

interface SavedFile extends SavedModelInfo { encodings: FeatureEncoding[]; body: ModelBody }

export function simulatorOf(encodings: FeatureEncoding[]): SavedModelInfo['simulator'] {
  return encodings.map((e) => {
    if (e.kind === 'cat') return { name: e.name, kind: e.kind, levels: e.levels, default: e.mode }
    if (e.kind === 'date') return { name: e.name, kind: e.kind, default: new Date(e.median * 86_400_000).toISOString().slice(0, 10) }
    return { name: e.name, kind: e.kind, default: Number(e.median.toFixed(4)) }
  })
}

export class ModelStore {
  readonly dir: string
  constructor(root: string) {
    this.dir = join(root, 'models')
  }

  private path(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Identifiant invalide')
    return join(this.dir, `${id}.json`)
  }

  private async read(id: string): Promise<SavedFile | null> {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')) as SavedFile } catch { return null }
  }

  /** Modèle utilisable : en mémoire (récent) ou relu sur disque. */
  async get(id: string): Promise<(Stored & { info?: SavedModelInfo }) | null> {
    const recent = recentModel(id)
    if (recent) return recent
    const f = await this.read(id)
    if (!f) return null
    const stored: Stored = {
      encodings: f.encodings, target: f.target, body: f.body, predict: predictorOf(f.body), label: f.label,
      metrics: f.metrics, summary: f.summary, rows: f.rows, createdAt: Date.parse(f.createdAt),
    }
    rememberModel(id, stored)
    return { ...stored, info: strip(f) }
  }

  async save(id: string, name: string, dataset: { id: string; name: string }): Promise<SavedModelInfo | null> {
    const s = recentModel(id)
    const existing = await this.read(id)
    if (!s && !existing) return null
    const file: SavedFile = existing
      ? { ...existing, name }
      : {
        id, name, datasetId: dataset.id, datasetName: dataset.name, target: s!.target, label: s!.label, metrics: s!.metrics,
        summary: s!.summary, features: s!.encodings.map((e) => e.name), simulator: simulatorOf(s!.encodings), rows: s!.rows,
        createdAt: new Date(s!.createdAt).toISOString(), encodings: s!.encodings, body: s!.body,
      }
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.path(id)}.tmp`
    await writeFile(tmp, JSON.stringify(file), 'utf8')
    await rename(tmp, this.path(id))
    return strip(file)
  }

  async list(datasetId?: string): Promise<SavedModelInfo[]> {
    const files = await readdir(this.dir).catch(() => [] as string[])
    const all = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => this.read(f.slice(0, -5))))
    return all.filter((f): f is SavedFile => !!f && (!datasetId || f.datasetId === datasetId))
      .map(strip).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async remove(id: string): Promise<void> {
    forgetModel(id)
    await rm(this.path(id), { force: true })
  }
}

function strip(f: SavedFile): SavedModelInfo {
  const { encodings: _e, body: _b, ...info } = f
  return info
}

/** Prédictions pour des lignes brutes ; colonnes ajoutées : prédiction (+ probabilité / confiance). */
export function scoreRows(s: Stored, rows: Record<string, unknown>[]): { columns: string[]; values: (string | number)[][] } {
  const out = s.predict(rows.map((r) => encodeRow(s.encodings, r)))
  const name = s.target.name
  if (s.target.task === 'regression') {
    return { columns: [`${name}_prédit`], values: out.map((o) => [Number(o[0].toFixed(4))]) }
  }
  const cls = s.target.classes
  if (s.target.task === 'binary') {
    return {
      columns: [`${name}_prédit`, `probabilité_${cls[1]}`],
      values: out.map((p) => [cls[p[1] >= 0.5 ? 1 : 0], Number(p[1].toFixed(4))]),
    }
  }
  return {
    columns: [`${name}_prédit`, 'confiance'],
    values: out.map((p) => { const i = p.indexOf(Math.max(...p)); return [cls[i], Number(p[i].toFixed(4))] }),
  }
}
