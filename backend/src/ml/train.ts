// Entraînement et comparaison de modèles prédictifs (onglet Prédiction et outil `predict` de l'agent).
//   Modèles : référence naïve, régression linéaire / logistique, gradient boosting d'arbres, réseau de neurones.
//   Évaluation : découpage 70 % entraînement / 10 % validation (arrêt anticipé) / 20 % test, toujours le même.
import { randomUUID } from 'node:crypto'

import type { DatasetDb } from '../db.js'
import type { Profile } from '../profile.js'
import type { ChartSpec } from '../store.js'
import { predictGbm, trainGbm, type GbmModel } from './gbm.js'
import { predictMlp, trainMlp, type MlpModel } from './mlp.js'
import { encodeRow, prepare, type FeatureEncoding, type Prepared, type TargetInfo } from './prepare.js'
import { rng, shuffle } from './rng.js'

export type ModelKind = 'baseline' | 'linear' | 'gbm' | 'mlp'

export const MODEL_LABELS: Record<ModelKind, string> = {
  baseline: 'Référence naïve',
  linear: 'Régression linéaire',
  gbm: 'Gradient boosting (arbres)',
  mlp: 'Réseau de neurones',
}

export const MODEL_HINTS: Record<ModelKind, string> = {
  baseline: 'Prédit toujours la moyenne (ou la classe la plus fréquente) : le score à battre.',
  linear: 'Relations additives et lisibles ; robuste sur peu de données.',
  gbm: 'Centaines de petits arbres corrigeant les erreurs des précédents (principe de XGBoost, LightGBM) ; souvent le meilleur sur des tableaux.',
  mlp: 'Apprentissage profond : deux couches cachées de neurones, optimiseur Adam ; capte des relations non linéaires.',
}

export interface Metric { key: string; label: string; value: number; higherIsBetter: boolean }

export interface ModelResult {
  kind: ModelKind
  label: string
  hint: string
  metrics: Metric[]
  score: number // métrique principale : R² (valeur), AUC (oui / non), taux de bonnes réponses (catégories)
  trainMs: number
  detail: string
}

export interface TrainResult {
  id: string
  target: TargetInfo
  task: TargetInfo['task']
  rows: { train: number; validation: number; test: number }
  features: string[]
  models: ModelResult[]
  best: ModelKind
  importance: ChartSpec
  quality: ChartSpec
  simulator: { name: string; kind: FeatureEncoding['kind']; levels?: string[]; default: string | number }[]
  summary: string
  durationMs: number
}

type Predictor = (X: number[][]) => number[][]

/** Paramètres d'un modèle entraîné, sérialisables en JSON (enregistrement sur disque). */
export type ModelBody =
  | { kind: 'baseline'; probs: number[] }
  | { kind: 'linear' | 'mlp'; mlp: MlpModel }
  | { kind: 'gbm'; gbm: GbmModel }

export function predictorOf(body: ModelBody): Predictor {
  if (body.kind === 'baseline') return (X) => X.map(() => body.probs)
  if (body.kind === 'gbm') return (X) => predictGbm(body.gbm, X)
  return (X) => predictMlp(body.mlp, X)
}

/** Modèle retenu après un entraînement : de quoi prédire et le décrire. */
export interface Stored {
  encodings: FeatureEncoding[]
  target: TargetInfo
  body: ModelBody
  predict: Predictor
  label: string
  metrics: Metric[]
  summary: string
  rows: number
  createdAt: number
}
const registry = new Map<string, Stored>()

function remember(id: string, s: Stored) {
  registry.set(id, s)
  while (registry.size > 20) registry.delete(registry.keys().next().value as string)
}

/** Derniers modèles entraînés (en mémoire). */
export function recentModel(id: string): Stored | undefined {
  return registry.get(id)
}
export function rememberModel(id: string, s: Stored): void {
  remember(id, s)
}
export function forgetModel(id: string): void {
  registry.delete(id)
}

const round = (x: number, d = 4) => (Number.isFinite(x) ? Number(x.toFixed(d)) : 0)
const fr = (x: number, d = 2) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d }).format(x)

// ── Métriques ──────────────────────────────────────────────────────────────────────────────────
function regressionMetrics(p: number[], y: number[]): Metric[] {
  const m = y.reduce((a, b) => a + b, 0) / y.length
  let sse = 0, sst = 0, mae = 0
  y.forEach((v, i) => { sse += (v - p[i]) ** 2; sst += (v - m) ** 2; mae += Math.abs(v - p[i]) })
  return [
    { key: 'r2', label: 'R²', value: round(sst ? 1 - sse / sst : 0), higherIsBetter: true },
    { key: 'mae', label: 'Erreur absolue moyenne', value: round(mae / y.length, 3), higherIsBetter: false },
    { key: 'rmse', label: 'Erreur quadratique (RMSE)', value: round(Math.sqrt(sse / y.length), 3), higherIsBetter: false },
  ]
}

function auc(scores: number[], y: number[]): number {
  const pairs = scores.map((s, i) => [s, y[i]]).sort((a, b) => a[0] - b[0])
  let rank = 0, sumPos = 0, nPos = 0
  for (let i = 0; i < pairs.length; i++) {
    let j = i
    while (j + 1 < pairs.length && pairs[j + 1][0] === pairs[i][0]) j++
    const r = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) if (pairs[k][1] === 1) { sumPos += r; nPos++ }
    rank = j
    i = j
  }
  void rank
  const nNeg = pairs.length - nPos
  return nPos && nNeg ? (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : 0.5
}

function classificationMetrics(probs: number[][], y: number[], k: number): Metric[] {
  const pred = probs.map((p) => p.indexOf(Math.max(...p)))
  const acc = pred.filter((p, i) => p === y[i]).length / y.length
  let f1 = 0
  for (let c = 0; c < k; c++) {
    const tp = pred.filter((p, i) => p === c && y[i] === c).length
    const fp = pred.filter((p, i) => p === c && y[i] !== c).length
    const fn = pred.filter((p, i) => p !== c && y[i] === c).length
    const pr = tp + fp ? tp / (tp + fp) : 0, rc = tp + fn ? tp / (tp + fn) : 0
    f1 += pr + rc ? (2 * pr * rc) / (pr + rc) : 0
  }
  const metrics: Metric[] = [
    { key: 'accuracy', label: 'Taux de bonnes réponses', value: round(acc), higherIsBetter: true },
    { key: 'f1', label: 'F1 (moyenne des classes)', value: round(f1 / k), higherIsBetter: true },
  ]
  // Cible oui / non : l'AUC devient la métrique principale (insensible au déséquilibre des classes).
  if (k === 2) metrics.unshift({ key: 'auc', label: 'AUC', value: round(auc(probs.map((p) => p[1]), y)), higherIsBetter: true })
  return metrics
}

// ── Modèles ────────────────────────────────────────────────────────────────────────────────────
interface Split { Xtr: number[][]; ytr: number[]; Xva: number[][]; yva: number[]; Xte: number[][]; yte: number[] }

function fit(kind: ModelKind, s: Split, task: TargetInfo['task'], k: number): { body: ModelBody; detail: string } {
  if (kind === 'baseline') {
    if (task === 'regression') {
      const m = s.ytr.reduce((a, b) => a + b, 0) / s.ytr.length
      return { body: { kind: 'baseline', probs: [m] }, detail: `moyenne = ${round(m, 3)}` }
    }
    const counts = new Array(k).fill(0)
    s.ytr.forEach((v) => counts[v]++)
    const p = counts.map((c) => c / s.ytr.length)
    return { body: { kind: 'baseline', probs: p }, detail: 'classe la plus fréquente' }
  }
  if (kind === 'linear') {
    const m: MlpModel = trainMlp(s.Xtr, s.ytr, s.Xva, s.yva, task, k, { hidden: [], epochs: 200, lr: 0.01, batch: 64, l2: 1e-4, timeBudgetMs: 6000 })
    return { body: { kind: 'linear', mlp: m }, detail: `${m.epochs} époques` }
  }
  if (kind === 'gbm') {
    const m: GbmModel = trainGbm(s.Xtr, s.ytr, s.Xva, s.yva, task, k, { timeBudgetMs: 15_000 })
    return { body: { kind: 'gbm', gbm: m }, detail: `${m.trees.length} arbres de profondeur 4` }
  }
  // Taille du réseau adaptée au volume : un petit jeu de données appelle un petit réseau, plus régularisé.
  const n = Math.min(s.Xtr.length, 6000)
  const small = n < 2000
  const m: MlpModel = trainMlp(s.Xtr.slice(0, n), s.ytr.slice(0, n), s.Xva, s.yva, task, k, small
    ? { hidden: [32, 16], epochs: 400, batch: 16, lr: 0.003, l2: 1e-3, patience: 40, timeBudgetMs: 15_000 }
    : { hidden: [48, 24], epochs: 200, batch: 32, lr: 0.003, l2: 1e-4, patience: 15, timeBudgetMs: 15_000 })
  return { body: { kind: 'mlp', mlp: m }, detail: `couches ${m.sizes.join(' → ')}, meilleure époque ${m.epochs}` }
}

function evaluate(task: TargetInfo['task'], k: number, out: number[][], y: number[]): Metric[] {
  return task === 'regression' ? regressionMetrics(out.map((o) => o[0]), y) : classificationMetrics(out, y, k)
}

// ── Entraînement complet ───────────────────────────────────────────────────────────────────────
export async function trainModels(db: DatasetDb, profile: Profile, target: string, features?: string[], kinds?: ModelKind[]): Promise<TrainResult> {
  const started = Date.now()
  const data: Prepared = await prepare(db, profile, target, features)
  const { task } = data.target
  const k = Math.max(2, data.target.classes.length)

  const order = shuffle(data.X.map((_, i) => i), rng(2024))
  const nTe = Math.max(10, Math.round(order.length * 0.2)), nVa = Math.max(10, Math.round(order.length * 0.1))
  const te = order.slice(0, nTe), va = order.slice(nTe, nTe + nVa), tr = order.slice(nTe + nVa)
  const pick = (idx: number[]) => ({ X: idx.map((i) => data.X[i]), y: idx.map((i) => data.y[i]) })
  const a = pick(tr), b = pick(va), c = pick(te)
  const split: Split = { Xtr: a.X, ytr: a.y, Xva: b.X, yva: b.y, Xte: c.X, yte: c.y }

  const wanted: ModelKind[] = kinds?.length ? kinds : ['baseline', 'linear', 'gbm', 'mlp']
  if (!wanted.includes('baseline')) wanted.unshift('baseline')
  const models: (ModelResult & { predict: Predictor; body: ModelBody })[] = []
  for (const kind of wanted) {
    const t0 = Date.now()
    const { body, detail } = fit(kind, split, task, k)
    const predict = predictorOf(body)
    const metrics = evaluate(task, k, predict(split.Xte), split.yte)
    const label = kind === 'linear' && task !== 'regression' ? 'Régression logistique' : MODEL_LABELS[kind]
    models.push({ kind, label, hint: MODEL_HINTS[kind], metrics, score: metrics[0].value, trainMs: Date.now() - t0, detail, predict, body })
  }
  const best = models.filter((m) => m.kind !== 'baseline').sort((x, y) => y.score - x.score)[0] ?? models[0]

  // Importance par permutation sur le jeu de test (baisse du score quand on mélange une variable).
  const rand = rng(99)
  const imp = data.encodings.map((e, gi) => {
    const cols = data.groups[gi]
    const perm = shuffle(split.Xte.map((_, i) => i), rand)
    const Xp = split.Xte.map((row, i) => { const r = [...row]; for (const cc of cols) r[cc] = split.Xte[perm[i]][cc]; return r })
    const s = evaluate(task, k, best.predict(Xp), split.yte)[0].value
    return { name: e.name, drop: Math.max(0, best.score - s) }
  }).sort((x, y) => y.drop - x.drop)
  const totalDrop = imp.reduce((s, v) => s + v.drop, 0) || 1

  const importance: ChartSpec = {
    type: 'horizontal_bar', title: 'Variables les plus influentes', subtitle: `${best.label} · baisse du score quand la variable est brouillée`,
    x: 'variable', y: ['influence_%'],
    data: { columns: ['variable', 'influence_%'], rows: imp.filter((v, i) => v.drop > 0 || i < 3).slice(0, 12).map((v) => [v.name, round((v.drop / totalDrop) * 100, 1)]) },
  }

  let quality: ChartSpec
  const outTe = best.predict(split.Xte)
  if (task === 'regression') {
    const pts = split.yte.map((v, i) => [round(v, 3), round(outTe[i][0], 3)]).slice(0, 600)
    quality = { type: 'scatter', diagonal: true, title: 'Valeurs réelles et prédites', subtitle: 'Jeu de test : plus les points suivent la diagonale, meilleur est le modèle', x: 'réel', y: ['prédit'], data: { columns: ['réel', 'prédit'], rows: pts } }
  } else {
    const cls = data.target.classes
    const counts = new Map<string, number>()
    outTe.forEach((p, i) => { const key = `${cls[split.yte[i]]}|${cls[p.indexOf(Math.max(...p))]}`; counts.set(key, (counts.get(key) ?? 0) + 1) })
    const rows: unknown[][] = []
    for (const r of cls) for (const p of cls) rows.push([p, r, counts.get(`${r}|${p}`) ?? 0])
    quality = { type: 'heatmap', title: 'Matrice de confusion', subtitle: 'Jeu de test : prédit (horizontal) contre réel (vertical)', x: 'prédit', series: 'réel', y: ['lignes'], data: { columns: ['prédit', 'réel', 'lignes'], rows } }
  }

  const id = randomUUID()

  const simulator = data.encodings.map((e) => {
    if (e.kind === 'cat') return { name: e.name, kind: e.kind, levels: e.levels, default: e.mode }
    if (e.kind === 'date') return { name: e.name, kind: e.kind, default: new Date(e.median * 86_400_000).toISOString().slice(0, 10) }
    return { name: e.name, kind: e.kind, default: round(e.median, 4) }
  })

  const base = models.find((m) => m.kind === 'baseline')!
  const main = best.metrics[0]
  const top = imp.slice(0, 3).filter((v) => v.drop > 0).map((v) => v.name)
  const summary = task === 'regression'
    ? `Modèle retenu : ${best.label}. Pour prédire « ${data.target.name} », R² de ${fr(main.value)} sur le jeu de test (référence : ${fr(base.score)}). ` +
      `Erreur moyenne ${fr(best.metrics[1].value)}.${top.length ? ` Variables les plus influentes : ${top.join(', ')}.` : ''}`
    : task === 'binary'
      ? `Modèle retenu : ${best.label}. Pour prédire « ${data.target.name} », AUC de ${fr(main.value)} sur le jeu de test (0,5 = hasard, 1 = parfait), ` +
        `${fr(best.metrics[1].value * 100, 1)} % de bonnes réponses (référence : ${fr(base.metrics[1].value * 100, 1)} %).` +
        `${top.length ? ` Variables les plus influentes : ${top.join(', ')}.` : ''}`
      : `Modèle retenu : ${best.label}. Pour prédire « ${data.target.name} » (${data.target.classes.join(' / ')}), ${fr(main.value * 100, 1)} % de bonnes réponses ` +
        `sur le jeu de test (référence : ${fr(base.score * 100, 1)} %).${top.length ? ` Variables les plus influentes : ${top.join(', ')}.` : ''}`

  remember(id, {
    encodings: data.encodings, target: data.target, body: best.body, predict: best.predict, label: best.label,
    metrics: best.metrics, summary, rows: data.X.length, createdAt: Date.now(),
  })

  return {
    id, target: data.target, task,
    rows: { train: tr.length, validation: va.length, test: te.length },
    features: data.encodings.map((e) => e.name),
    models: models.map(({ predict: _p, body: _b, ...m }) => m),
    best: best.kind, importance, quality, simulator, summary,
    durationMs: Date.now() - started,
  }
}

/** Prédiction pour une ligne saisie dans le simulateur. */
export function predictOne(s: Stored, values: Record<string, unknown>): { model: string; value?: number; probabilities?: { label: string; p: number }[] } {
  const out = s.predict([encodeRow(s.encodings, values)])[0]
  if (s.target.task === 'regression') return { model: s.label, value: round(out[0], 4) }
  return {
    model: s.label,
    probabilities: s.target.classes.map((label, i) => ({ label, p: round(out[i], 4) })).sort((a, b) => b.p - a.p),
  }
}
