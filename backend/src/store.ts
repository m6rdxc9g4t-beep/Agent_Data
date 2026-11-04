// Stockage des métadonnées en fichiers JSON (écriture atomique), dans DATA_DIR :
//   datasets/<id>/meta.json, data.parquet, source.<ext>
//   conversations/<id>.json
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Column } from './db.js'

export interface DatasetMeta {
  id: string
  name: string
  fileName: string
  format: string
  rows: number
  columns: Column[]
  sizeBytes: number
  createdAt: string
  sheets: string[]
  sheet: string | null
  sample: boolean
}

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; result?: ToolOutput }

export interface ToolOutput {
  ok: boolean
  summary: string
  error?: string
  table?: { columns: Column[]; rows: unknown[][]; truncated: boolean }
  chart?: ChartSpec
  sql?: string
}

export interface ChartSpec {
  type: 'bar' | 'horizontal_bar' | 'line' | 'area' | 'scatter' | 'pie' | 'histogram' | 'heatmap'
  title: string
  subtitle?: string
  x: string
  y: string[]
  series?: string
  data: { columns: string[]; rows: unknown[][] }
  stacked?: boolean
  xLabel?: string
  yLabel?: string
}

export interface Turn {
  id: string
  question: string
  label?: string
  blocks: Block[]
  engine: string
  model: string
  createdAt: string
  durationMs?: number
  usage?: { inputTokens: number; outputTokens: number }
  error?: string
}

export interface Conversation {
  id: string
  datasetId: string
  title: string
  createdAt: string
  updatedAt: string
  turns: Turn[]
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 1), 'utf8')
  await rename(tmp, path)
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

export class Store {
  readonly datasetsDir: string
  readonly conversationsDir: string

  constructor(readonly root: string) {
    this.datasetsDir = join(root, 'datasets')
    this.conversationsDir = join(root, 'conversations')
  }

  async init(): Promise<void> {
    await mkdir(this.datasetsDir, { recursive: true })
    await mkdir(this.conversationsDir, { recursive: true })
    await mkdir(join(this.root, 'tmp'), { recursive: true })
  }

  tmpPath(name: string): string {
    return join(this.root, 'tmp', `${randomUUID()}-${name.replace(/[^\w.-]/g, '_')}`)
  }

  datasetDir(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Identifiant invalide')
    return join(this.datasetsDir, id)
  }

  parquetPath(id: string): string {
    return join(this.datasetDir(id), 'data.parquet')
  }

  async listDatasets(): Promise<DatasetMeta[]> {
    const ids = await readdir(this.datasetsDir).catch(() => [] as string[])
    const metas = await Promise.all(ids.map((id) => readJson<DatasetMeta>(join(this.datasetsDir, id, 'meta.json'))))
    return metas.filter((m): m is DatasetMeta => !!m).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  getDataset(id: string): Promise<DatasetMeta | null> {
    return readJson<DatasetMeta>(join(this.datasetDir(id), 'meta.json'))
  }

  async saveDataset(meta: DatasetMeta): Promise<void> {
    await mkdir(this.datasetDir(meta.id), { recursive: true })
    await writeJson(join(this.datasetDir(meta.id), 'meta.json'), meta)
  }

  async deleteDataset(id: string): Promise<void> {
    await rm(this.datasetDir(id), { recursive: true, force: true })
    for (const c of await this.listConversations(id)) await this.deleteConversation(c.id)
  }

  private conversationPath(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Identifiant invalide')
    return join(this.conversationsDir, `${id}.json`)
  }

  async listConversations(datasetId: string): Promise<Omit<Conversation, 'turns'>[]> {
    const files = await readdir(this.conversationsDir).catch(() => [] as string[])
    const all = await Promise.all(files.filter((f) => f.endsWith('.json'))
      .map((f) => readJson<Conversation>(join(this.conversationsDir, f))))
    return all
      .filter((c): c is Conversation => !!c && c.datasetId === datasetId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ turns, ...rest }) => ({ ...rest, turnCount: turns.length }))
  }

  getConversation(id: string): Promise<Conversation | null> {
    return readJson<Conversation>(this.conversationPath(id))
  }

  async createConversation(datasetId: string): Promise<Conversation> {
    const now = new Date().toISOString()
    const conv: Conversation = { id: randomUUID(), datasetId, title: 'Nouvelle analyse', createdAt: now, updatedAt: now, turns: [] }
    await this.saveConversation(conv)
    return conv
  }

  async saveConversation(conv: Conversation): Promise<void> {
    conv.updatedAt = new Date().toISOString()
    await writeJson(this.conversationPath(conv.id), conv)
  }

  async deleteConversation(id: string): Promise<void> {
    await rm(this.conversationPath(id), { force: true })
  }
}
