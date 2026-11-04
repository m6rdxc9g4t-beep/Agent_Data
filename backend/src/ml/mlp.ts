// Réseau de neurones à propagation avant (perceptron multicouche), en TypeScript pur.
//   - couches cachées ReLU (aucune couche cachée = régression linéaire / logistique / softmax) ;
//   - optimiseur Adam par mini-lots, pénalité L2, arrêt anticipé sur un jeu de validation ;
//   - sortie linéaire (régression), sigmoïde (binaire) ou softmax (multiclasse).
import { gaussian, rng, shuffle } from './rng.js'
import type { Task } from './gbm.js'

export interface MlpOptions {
  hidden?: number[]
  epochs?: number
  batch?: number
  lr?: number
  l2?: number
  patience?: number
  seed?: number
  timeBudgetMs?: number
}

export interface MlpModel {
  task: Task
  sizes: number[]
  W: number[][][] // W[l][out][in]
  b: number[][]
  yMean: number
  yStd: number
  epochs: number
}

function forward(m: MlpModel, x: number[]): number[][] {
  const acts: number[][] = [x]
  for (let l = 0; l < m.W.length; l++) {
    const prev = acts[l], W = m.W[l], b = m.b[l]
    const last = l === m.W.length - 1
    const out = new Array(W.length)
    for (let o = 0; o < W.length; o++) {
      let s = b[o]
      const w = W[o]
      for (let i = 0; i < prev.length; i++) s += w[i] * prev[i]
      out[o] = last ? s : s > 0 ? s : 0
    }
    acts.push(out)
  }
  return acts
}

function output(task: Task, z: number[]): number[] {
  if (task === 'regression') return z
  if (task === 'binary') { const p = 1 / (1 + Math.exp(-z[0])); return [1 - p, p] }
  const mx = Math.max(...z), e = z.map((v) => Math.exp(v - mx)), s = e.reduce((a, c) => a + c, 0)
  return e.map((v) => v / s)
}

function lossOf(m: MlpModel, X: number[][], y: number[]): number {
  let l = 0
  for (let i = 0; i < X.length; i++) {
    const z = forward(m, X[i]).at(-1)!
    if (m.task === 'regression') l += (z[0] - (y[i] - m.yMean) / m.yStd) ** 2
    else { const p = output(m.task, z); l -= Math.log(Math.max(1e-12, m.task === 'binary' ? p[y[i]] : p[y[i]])) }
  }
  return l / Math.max(1, X.length)
}

const clone = (m: MlpModel): MlpModel => ({ ...m, W: m.W.map((L) => L.map((r) => [...r])), b: m.b.map((r) => [...r]) })

export function trainMlp(X: number[][], y: number[], Xv: number[][], yv: number[], task: Task, classes: number, opts: MlpOptions = {}): MlpModel {
  const o = { hidden: [64, 32], epochs: 150, batch: 32, lr: 0.003, l2: 1e-4, patience: 15, seed: 7, timeBudgetMs: 20_000, ...opts }
  const started = Date.now()
  const rand = rng(o.seed)
  const outSize = task === 'multiclass' ? classes : 1
  const sizes = [X[0].length, ...o.hidden, outSize]
  const yMean = task === 'regression' ? y.reduce((a, b) => a + b, 0) / y.length : 0
  const yStd = task === 'regression' ? Math.sqrt(y.reduce((a, b) => a + (b - yMean) ** 2, 0) / y.length) || 1 : 1
  const m: MlpModel = {
    task, sizes, yMean, yStd, epochs: 0,
    W: sizes.slice(1).map((n, l) => Array.from({ length: n }, () => Array.from({ length: sizes[l] }, () => gaussian(rand) * Math.sqrt(2 / sizes[l])))),
    b: sizes.slice(1).map((n) => new Array(n).fill(0)),
  }
  // Moments d'Adam
  const mW = m.W.map((L) => L.map((r) => r.map(() => 0))), vW = m.W.map((L) => L.map((r) => r.map(() => 0)))
  const mb = m.b.map((r) => r.map(() => 0)), vb = m.b.map((r) => r.map(() => 0))
  let step = 0, best = Infinity, bestModel = clone(m), since = 0
  const order = X.map((_, i) => i)

  for (let epoch = 0; epoch < o.epochs; epoch++) {
    shuffle(order, rand)
    for (let s = 0; s < order.length; s += o.batch) {
      const batch = order.slice(s, s + o.batch)
      const gW = m.W.map((L) => L.map((r) => new Array(r.length).fill(0)))
      const gb = m.b.map((r) => new Array(r.length).fill(0))
      for (const i of batch) {
        const acts = forward(m, X[i])
        const z = acts.at(-1)!
        // Gradient de la perte par rapport à la sortie
        let delta: number[]
        if (task === 'regression') delta = [z[0] - (y[i] - yMean) / yStd]
        else if (task === 'binary') delta = [output(task, z)[1] - y[i]]
        else delta = output(task, z).map((p, k) => p - (k === y[i] ? 1 : 0))
        for (let l = m.W.length - 1; l >= 0; l--) {
          const prev = acts[l]
          for (let oo = 0; oo < delta.length; oo++) {
            gb[l][oo] += delta[oo]
            const row = gW[l][oo], d = delta[oo]
            for (let ii = 0; ii < prev.length; ii++) row[ii] += d * prev[ii]
          }
          if (l > 0) {
            const next = new Array(prev.length).fill(0)
            for (let oo = 0; oo < delta.length; oo++) {
              const w = m.W[l][oo], d = delta[oo]
              for (let ii = 0; ii < prev.length; ii++) next[ii] += w[ii] * d
            }
            delta = next.map((v, ii) => (prev[ii] > 0 ? v : 0))
          }
        }
      }
      step++
      const b1 = 0.9, b2 = 0.999, eps = 1e-8, scale = 1 / batch.length
      const c1 = 1 - b1 ** step, c2 = 1 - b2 ** step
      for (let l = 0; l < m.W.length; l++) {
        for (let oo = 0; oo < m.W[l].length; oo++) {
          const w = m.W[l][oo]
          for (let ii = 0; ii < w.length; ii++) {
            const gr = gW[l][oo][ii] * scale + o.l2 * w[ii]
            mW[l][oo][ii] = b1 * mW[l][oo][ii] + (1 - b1) * gr
            vW[l][oo][ii] = b2 * vW[l][oo][ii] + (1 - b2) * gr * gr
            w[ii] -= (o.lr * (mW[l][oo][ii] / c1)) / (Math.sqrt(vW[l][oo][ii] / c2) + eps)
          }
          const gr = gb[l][oo] * scale
          mb[l][oo] = b1 * mb[l][oo] + (1 - b1) * gr
          vb[l][oo] = b2 * vb[l][oo] + (1 - b2) * gr * gr
          m.b[l][oo] -= (o.lr * (mb[l][oo] / c1)) / (Math.sqrt(vb[l][oo] / c2) + eps)
        }
      }
    }
    m.epochs = epoch + 1
    const lv = lossOf(m, Xv.length ? Xv : X, Xv.length ? yv : y)
    if (lv < best - 1e-6) { best = lv; bestModel = clone(m); since = 0 } else if (++since >= o.patience) break
    if (Date.now() - started > o.timeBudgetMs) break
  }
  return bestModel
}

export function predictMlp(m: MlpModel, X: number[][]): number[][] {
  return X.map((x) => {
    const z = forward(m, x).at(-1)!
    return m.task === 'regression' ? [z[0] * m.yStd + m.yMean] : output(m.task, z)
  })
}
