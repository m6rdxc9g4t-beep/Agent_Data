// Gradient boosting d'arbres de décision par histogrammes (principe de LightGBM / XGBoost), en TypeScript pur.
//   - les variables sont discrétisées en 32 intervalles au plus (quantiles) : la recherche des coupures est rapide ;
//   - perte quadratique (régression), logistique (binaire) ou softmax (multiclasse, un arbre par classe et par tour) ;
//   - sous-échantillonnage des lignes, régularisation L2 des feuilles, arrêt anticipé sur un jeu de validation.
import { rng } from './rng.js'

export type Task = 'regression' | 'binary' | 'multiclass'

interface Node { f: number; bin: number; left: number; right: number; value: number }
type Tree = Node[]

export interface GbmOptions {
  rounds?: number
  learningRate?: number
  maxDepth?: number
  minLeaf?: number
  lambda?: number
  subsample?: number
  bins?: number
  seed?: number
  timeBudgetMs?: number
}

export interface GbmModel {
  task: Task
  classes: number
  base: number[]
  edges: number[][]
  trees: Tree[][]
  learningRate: number
  bestRound: number
}

function quantileEdges(values: Float64Array, bins: number): number[] {
  const sorted = Float64Array.from(values).sort()
  const edges: number[] = []
  for (let b = 1; b < bins; b++) {
    const v = sorted[Math.floor((b / bins) * (sorted.length - 1))]
    if (!edges.length || v > edges[edges.length - 1]) edges.push(v)
  }
  return edges
}

function binOf(v: number, edges: number[]): number {
  let lo = 0, hi = edges.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (v > edges[mid]) lo = mid + 1
    else hi = mid
  }
  return lo
}

function binarize(X: number[][], edges: number[][]): Uint8Array[] {
  const d = edges.length
  return Array.from({ length: d }, (_, j) => {
    const col = new Uint8Array(X.length)
    for (let i = 0; i < X.length; i++) col[i] = binOf(X[i][j], edges[j])
    return col
  })
}

function buildTree(B: Uint8Array[], nBins: number[], g: Float64Array, h: Float64Array, rows: Int32Array, o: Required<GbmOptions>): Tree {
  const tree: Tree = []
  const grow = (idx: Int32Array, depth: number): number => {
    let G = 0, H = 0
    for (let k = 0; k < idx.length; k++) { G += g[idx[k]]; H += h[idx[k]] }
    const node: Node = { f: -1, bin: 0, left: -1, right: -1, value: -G / (H + o.lambda) }
    const id = tree.push(node) - 1
    if (depth >= o.maxDepth || idx.length < 2 * o.minLeaf) return id
    let bestGain = 1e-9, bestF = -1, bestBin = 0
    const parent = (G * G) / (H + o.lambda)
    for (let f = 0; f < B.length; f++) {
      const nb = nBins[f]
      if (nb < 2) continue
      const hg = new Float64Array(nb), hh = new Float64Array(nb), hc = new Int32Array(nb)
      const col = B[f]
      for (let k = 0; k < idx.length; k++) { const r = idx[k], b = col[r]; hg[b] += g[r]; hh[b] += h[r]; hc[b]++ }
      let gl = 0, hl = 0, cl = 0
      for (let b = 0; b < nb - 1; b++) {
        gl += hg[b]; hl += hh[b]; cl += hc[b]
        const cr = idx.length - cl
        if (cl < o.minLeaf || cr < o.minLeaf) continue
        const gr = G - gl, hr = H - hl
        const gain = (gl * gl) / (hl + o.lambda) + (gr * gr) / (hr + o.lambda) - parent
        if (gain > bestGain) { bestGain = gain; bestF = f; bestBin = b }
      }
    }
    if (bestF < 0) return id
    const col = B[bestF]
    let nl = 0
    for (let k = 0; k < idx.length; k++) if (col[idx[k]] <= bestBin) nl++
    const L = new Int32Array(nl), R = new Int32Array(idx.length - nl)
    let a = 0, c = 0
    for (let k = 0; k < idx.length; k++) { const r = idx[k]; if (col[r] <= bestBin) L[a++] = r; else R[c++] = r }
    node.f = bestF
    node.bin = bestBin
    node.left = grow(L, depth + 1)
    node.right = grow(R, depth + 1)
    return id
  }
  grow(rows, 0)
  return tree
}

function treeValue(tree: Tree, bins: (f: number) => number): number {
  let n = tree[0]
  while (n.f >= 0) n = tree[bins(n.f) <= n.bin ? n.left : n.right]
  return n.value
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))

function softmax(z: number[]): number[] {
  const m = Math.max(...z)
  const e = z.map((v) => Math.exp(v - m))
  const s = e.reduce((a, b) => a + b, 0)
  return e.map((v) => v / s)
}

/** Sortie brute (scores) pour chaque ligne, à partir des intervalles déjà calculés. */
function rawScores(model: GbmModel, B: Uint8Array[], n: number, upTo = model.trees.length): Float64Array[] {
  const K = model.task === 'multiclass' ? model.classes : 1
  const out = Array.from({ length: K }, (_, k) => new Float64Array(n).fill(model.base[k]))
  for (let t = 0; t < upTo; t++) {
    for (let k = 0; k < K; k++) {
      const tree = model.trees[t][k]
      for (let i = 0; i < n; i++) out[k][i] += model.learningRate * treeValue(tree, (f) => B[f][i])
    }
  }
  return out
}

function loss(task: Task, scores: Float64Array[], y: number[]): number {
  let l = 0
  for (let i = 0; i < y.length; i++) {
    if (task === 'regression') l += (y[i] - scores[0][i]) ** 2
    else if (task === 'binary') { const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(scores[0][i]))); l -= y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p) }
    else { const p = softmax(scores.map((s) => s[i])); l -= Math.log(Math.max(1e-12, p[y[i]])) }
  }
  return l / y.length
}

export function trainGbm(X: number[][], y: number[], Xv: number[][], yv: number[], task: Task, classes: number, opts: GbmOptions = {}): GbmModel {
  const o: Required<GbmOptions> = {
    rounds: 300, learningRate: 0.08, maxDepth: 4, minLeaf: 10, lambda: 1, subsample: 0.8, bins: 32, seed: 42, timeBudgetMs: 20_000, ...opts,
  }
  const started = Date.now()
  const rand = rng(o.seed)
  const n = X.length, d = X[0]?.length ?? 0
  const edges = Array.from({ length: d }, (_, j) => quantileEdges(Float64Array.from(X, (r) => r[j]), o.bins))
  const nBins = edges.map((e) => e.length + 1)
  const B = binarize(X, edges), Bv = binarize(Xv, edges)
  const K = task === 'multiclass' ? classes : 1

  let base: number[]
  if (task === 'regression') base = [y.reduce((a, b) => a + b, 0) / n]
  else if (task === 'binary') { const p = Math.min(0.999, Math.max(0.001, y.reduce((a, b) => a + b, 0) / n)); base = [Math.log(p / (1 - p))] }
  else base = Array.from({ length: K }, (_, k) => Math.log(Math.max(1e-3, y.filter((v) => v === k).length / n)))

  const model: GbmModel = { task, classes, base, edges, trees: [], learningRate: o.learningRate, bestRound: 0 }
  const F = Array.from({ length: K }, (_, k) => new Float64Array(n).fill(base[k]))
  const Fv = Array.from({ length: K }, (_, k) => new Float64Array(Xv.length).fill(base[k]))
  let best = Infinity, since = 0
  const g = new Float64Array(n), h = new Float64Array(n)

  for (let t = 0; t < o.rounds; t++) {
    const sample = Int32Array.from({ length: n }, (_, i) => i).filter(() => rand() < o.subsample)
    const round: Tree[] = []
    for (let k = 0; k < K; k++) {
      for (let i = 0; i < n; i++) {
        if (task === 'regression') { g[i] = F[0][i] - y[i]; h[i] = 1 }
        else if (task === 'binary') { const p = sigmoid(F[0][i]); g[i] = p - y[i]; h[i] = Math.max(p * (1 - p), 1e-6) }
        else {
          const p = softmax(F.map((s) => s[i]))[k]
          g[i] = p - (y[i] === k ? 1 : 0); h[i] = Math.max(p * (1 - p), 1e-6)
        }
      }
      const tree = buildTree(B, nBins, g, h, sample, o)
      round.push(tree)
    }
    for (let k = 0; k < K; k++) {
      for (let i = 0; i < n; i++) F[k][i] += o.learningRate * treeValue(round[k], (f) => B[f][i])
      for (let i = 0; i < Xv.length; i++) Fv[k][i] += o.learningRate * treeValue(round[k], (f) => Bv[f][i])
    }
    model.trees.push(round)
    const lv = Xv.length ? loss(task, Fv, yv) : 0
    if (lv < best - 1e-9) { best = lv; model.bestRound = t + 1; since = 0 } else if (++since >= 25) break
    if (Date.now() - started > o.timeBudgetMs) break
  }
  model.trees = model.trees.slice(0, Math.max(1, model.bestRound))
  return model
}

/** Prédiction : valeur (régression), probabilité de la classe 1 (binaire) ou probabilités (multiclasse). */
export function predictGbm(model: GbmModel, X: number[][]): number[][] {
  const B = binarize(X, model.edges)
  const s = rawScores(model, B, X.length)
  return X.map((_, i) => {
    if (model.task === 'regression') return [s[0][i]]
    if (model.task === 'binary') { const p = sigmoid(s[0][i]); return [1 - p, p] }
    return softmax(s.map((c) => c[i]))
  })
}
