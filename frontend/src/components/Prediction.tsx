// Onglet Prédiction : apprentissage automatique sans écrire de code.
//   « Prévoir une variable » : entraîne et compare quatre modèles, explique le meilleur et permet de le tester.
//   « Prévoir dans le temps » : compare quatre méthodes de prévision sur les dernières périodes et projette.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BrainCircuit, ChartSpline, Check, Download, LoaderCircle, MessageSquareText, Play, Save, SlidersHorizontal, Trash2, Wand2 } from 'lucide-react'

import { api } from '../api'
import { useDemo } from '../demo'
import { fmtInt, fmtNumber, fmtPct } from '../format'
import type { DatasetDetail, ForecastResult, MlOptions, SavedModel, ScorePreview, Task, TrainResult } from '../types'
import { ChartFigure } from './Chart'
import { ResultTable } from './ResultTable'

const TASK_LABEL: Record<Task, string> = { regression: 'valeur', binary: 'oui / non', multiclass: 'catégorie' }

function fmtMetric(key: string, v: number): string {
  if (key === 'accuracy' || key === 'f1') return fmtPct(v)
  if (key === 'r2' || key === 'auc') return fmtNumber(Math.round(v * 1000) / 1000)
  return fmtNumber(v)
}

function FeaturePicker({ options, target, selected, onChange }: {
  options: MlOptions['features']; target: string; selected: string[]; onChange: (s: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const usable = options.filter((f) => f.usable && f.name !== target)
  const toggle = (n: string) => onChange(selected.includes(n) ? selected.filter((x) => x !== n) : [...selected, n])
  return (
    <div className="picker" ref={ref}>
      <button type="button" className="field-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <SlidersHorizontal size={14} /> {selected.length} variable{selected.length > 1 ? 's' : ''} sur {usable.length}
      </button>
      {open && (
        <div className="menu picker-menu">
          <div className="picker-actions">
            <button type="button" onClick={() => onChange(usable.map((f) => f.name))}>Toutes</button>
            <button type="button" onClick={() => onChange([])}>Aucune</button>
          </div>
          {usable.map((f) => (
            <label key={f.name} className="check">
              <input type="checkbox" checked={selected.includes(f.name)} onChange={() => toggle(f.name)} />
              <span>{f.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function Simulator({ result }: { result: { id: string; simulator: TrainResult['simulator']; target: { name: string } } }) {
  const [values, setValues] = useState<Record<string, string | number>>(() => Object.fromEntries(result.simulator.map((f) => [f.name, f.default])))
  const [out, setOut] = useState<Awaited<ReturnType<typeof api.predictOne>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const t = setTimeout(() => {
      api.predictOne(result.id, values).then((o) => { setOut(o); setError(null) }).catch((e: Error) => setError(e.message))
    }, 250)
    return () => clearTimeout(t)
  }, [result.id, values])
  return (
    <section className="simulator">
      <div className="sim-head">
        <h3>Tester le modèle</h3>
        <p>Modifiez les valeurs : la prédiction du modèle retenu se met à jour.</p>
      </div>
      <div className="sim-grid">
        {result.simulator.map((f) => (
          <label key={f.name} className="sim-field">
            <span>{f.name}</span>
            {f.kind === 'cat'
              ? <select value={String(values[f.name])} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                  {f.levels!.map((l) => <option key={l}>{l}</option>)}
                </select>
              : <input type={f.kind === 'date' ? 'date' : 'number'} step="any" value={values[f.name]}
                  onChange={(e) => setValues({ ...values, [f.name]: f.kind === 'date' ? e.target.value : e.target.value === '' ? '' : Number(e.target.value) })} />}
          </label>
        ))}
      </div>
      <div className="sim-out" aria-live="polite">
        {error && <p className="step-error">{error}</p>}
        {!error && out?.value !== undefined && (
          <p><span>{result.target.name} prédit</span><strong>{fmtNumber(out.value)}</strong></p>
        )}
        {!error && out?.probabilities && (
          <ul className="probas">
            {out.probabilities.map((p) => (
              <li key={p.label}>
                <span className="proba-label">{p.label}</span>
                <span className="bar wide"><span style={{ width: `${p.p * 100}%` }} /></span>
                <strong>{fmtPct(p.p, 0)}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function SaveModel({ result, dataset, onSaved }: { result: TrainResult; dataset: DatasetDetail; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(`Prédire ${result.target.name} — ${dataset.name.replace(/\.[^.]+$/, '')}`)
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)
  const save = () => {
    setState('saving')
    api.saveModel(result.id, dataset.id, name).then(() => { setState('saved'); setEditing(false); onSaved() })
      .catch((e: Error) => { setError(e.message); setState('idle') })
  }
  if (state === 'saved') return <span className="saved-note"><Check size={15} /> Modèle enregistré</span>
  if (!editing) return <button type="button" className="ghost-btn" onClick={() => setEditing(true)}><Save size={15} /> Enregistrer le modèle</button>
  return (
    <span className="save-model">
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="Nom du modèle" autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) save(); if (e.key === 'Escape') setEditing(false) }} />
      <button type="button" className="primary-btn" onClick={save} disabled={!name.trim() || state === 'saving'}>
        {state === 'saving' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />} Enregistrer
      </button>
      {error && <span className="step-error">{error}</span>}
    </span>
  )
}

function VariableMode({ dataset, options, onAsk, onSaved }: {
  dataset: DatasetDetail; options: MlOptions; onAsk: (prompt: string, label: string) => void; onSaved: () => void
}) {
  const demo = useDemo()
  const [target, setTarget] = useState(options.targets[0]?.name ?? '')
  const [features, setFeatures] = useState<string[]>([])
  const [result, setResult] = useState<TrainResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setFeatures(options.features.filter((f) => f.usable && f.name !== target).map((f) => f.name))
  }, [target, options])

  const train = () => {
    setBusy(true)
    setError(null)
    api.train(dataset.id, { target, features }).then(setResult).catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  const task = options.targets.find((t) => t.name === target)?.task
  const best = result?.models.find((m) => m.kind === result.best)

  const askAgent = () => {
    if (!result) return
    const board = result.models.map((m) => `- ${m.label} : ${m.metrics.map((x) => `${x.label} ${fmtMetric(x.key, x.value)}`).join(', ')}`).join('\n')
    const imp = result.importance.data.rows.slice(0, 8).map((r) => `${r[0]} (${r[1]} %)`).join(', ')
    onAsk(`J'ai entraîné des modèles pour prédire « ${result.target.name} » dans l'onglet Prédiction.\n${result.summary}\n\nComparaison sur le jeu de test :\n${board}\n\nInfluence des variables : ${imp}.\n\n` +
      'Explique ces résultats simplement : le modèle est-il fiable et utile, que disent les variables influentes (vérifie-les sur les données si besoin), quelles limites et quelles prochaines étapes ?',
    `Commenter le modèle « ${result.target.name} »`)
  }

  return (
    <>
      <div className="ml-form">
        <label className="field">
          <span>Variable à prédire</span>
          <select value={target} onChange={(e) => { setTarget(e.target.value); setResult(null) }}>
            {options.targets.map((t) => <option key={t.name} value={t.name}>{t.name} ({TASK_LABEL[t.task]})</option>)}
          </select>
        </label>
        <div className="field">
          <span>À partir de</span>
          <FeaturePicker options={options.features} target={target} selected={features} onChange={setFeatures} />
        </div>
        <button type="button" className="primary-btn" onClick={train} disabled={busy || !target || !features.length}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <Play size={15} />} {busy ? 'Entraînement…' : result ? 'Réentraîner' : 'Entraîner et comparer'}
        </button>
      </div>
      {task && !result && !busy && (
        <p className="ml-explain">
          {task === 'regression' ? 'Les modèles apprendront à estimer une valeur numérique.' : 'Les modèles apprendront à classer chaque ligne.'} DataMind en entraîne
          quatre — une référence naïve, une régression {task === 'regression' ? 'linéaire' : 'logistique'}, un gradient boosting d’arbres et un réseau de neurones —
          sur 70 % des lignes, puis les compare sur 20 % qu’ils n’ont jamais vues.
        </p>
      )}
      {busy && <p className="ml-explain"><LoaderCircle size={15} className="spin" /> Entraînement des quatre modèles sur {fmtInt(Math.min(dataset.rows, 20000))} lignes…</p>}
      {error && <p className="hint-warn">{error}</p>}

      {result && best && (
        <div className="ml-result">
          <div className="verdict">
            <BrainCircuit size={20} aria-hidden />
            <p>{result.summary}</p>
            <div className="verdict-actions">
              {!demo && <SaveModel key={result.id} result={result} dataset={dataset} onSaved={onSaved} />}
              <button type="button" className="ghost-btn" onClick={askAgent}><MessageSquareText size={15} /> Faire commenter par l’agent</button>
            </div>
          </div>

          <div className="result-table leaderboard">
            <table>
              <thead>
                <tr>
                  <th>Modèle</th>
                  {result.models[0].metrics.map((m) => <th key={m.key} className="num">{m.label}</th>)}
                  <th className="num">Temps</th>
                </tr>
              </thead>
              <tbody>
                {result.models.map((m) => (
                  <tr key={m.kind} className={m.kind === result.best ? 'best' : undefined}>
                    <td>
                      <span className="model-name">{m.label}{m.kind === result.best && <span className="badge"><Check size={12} /> Retenu</span>}</span>
                      <span className="model-hint">{m.hint}</span>
                    </td>
                    {m.metrics.map((x) => <td key={x.key} className="num">{fmtMetric(x.key, x.value)}</td>)}
                    <td className="num muted">{m.trainMs < 1000 ? `${m.trainMs} ms` : `${(m.trainMs / 1000).toFixed(1).replace('.', ',')} s`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="table-note">
              {fmtInt(result.rows.train)} lignes d’entraînement, {fmtInt(result.rows.validation)} de validation, {fmtInt(result.rows.test)} de test ·
              {result.task === 'regression' ? ' R² : 1 = parfait, 0 = pas mieux que la moyenne'
                : result.task === 'binary' ? ' AUC : 0,5 = hasard, 1 = parfait' : ' À comparer à la référence naïve'}
            </p>
          </div>

          <div className="grid-2">
            <ChartFigure spec={result.quality} height={300} pinSource="Prédiction" />
            <ChartFigure spec={result.importance} height={300} pinSource="Prédiction" />
          </div>

          <Simulator key={result.id} result={result} />
        </div>
      )}
    </>
  )
}

function ApplyMode({ dataset, models, onChanged }: { dataset: DatasetDetail; models: SavedModel[]; onChanged: () => void }) {
  const [selected, setSelected] = useState<string | null>(models[0]?.id ?? null)
  const [preview, setPreview] = useState<ScorePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sim, setSim] = useState(false)
  const model = models.find((m) => m.id === selected) ?? null

  useEffect(() => { setPreview(null); setError(null); setSim(false) }, [selected, dataset.id])
  useEffect(() => { if (!models.some((m) => m.id === selected)) setSelected(models[0]?.id ?? null) }, [models, selected])

  const run = () => {
    if (!model) return
    setBusy(true); setError(null)
    api.scorePreview(model.id, dataset.id).then(setPreview).catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  const remove = (m: SavedModel) => {
    if (!confirm(`Supprimer le modèle « ${m.name} » ?`)) return
    api.deleteModel(m.id).then(onChanged).catch((e: Error) => setError(e.message))
  }

  if (!models.length) {
    return (
      <p className="ml-note">
        Aucun modèle enregistré. Entraînez un modèle dans « Prévoir une variable », puis cliquez sur <strong>Enregistrer le modèle</strong> :
        il restera disponible après un redémarrage et pourra prédire les lignes de n’importe quel autre fichier ayant les mêmes colonnes
        (par exemple de nouveaux clients).
      </p>
    )
  }
  return (
    <div className="apply">
      <ul className="model-list">
        {models.map((m) => (
          <li key={m.id} className={m.id === selected ? 'on' : undefined}>
            <button type="button" className="model-pick" onClick={() => setSelected(m.id)} aria-pressed={m.id === selected}>
              <strong>{m.name}</strong>
              <span>{m.label} · {m.metrics[0].label} {fmtMetric(m.metrics[0].key, m.metrics[0].value)}</span>
              <span className="muted">Entraîné sur « {m.datasetName} » ({fmtInt(m.rows)} lignes) le {new Date(m.createdAt).toLocaleDateString('fr-FR')}</span>
            </button>
            <button type="button" className="icon-btn small" onClick={() => remove(m)} title="Supprimer ce modèle"><Trash2 size={14} /></button>
          </li>
        ))}
      </ul>

      {model && (
        <div className="apply-panel">
          <p className="ml-note">
            Applique « {model.name} » à chaque ligne de <strong>{dataset.name}</strong> et ajoute la colonne <code>{model.target.name}_prédit</code>
            {model.target.task === 'binary' && ' avec sa probabilité'}{model.target.task === 'multiclass' && ' avec la confiance du modèle'}.
            {model.datasetId !== dataset.id ? ' Si des colonnes manquent dans ce fichier, elles sont remplacées par des valeurs typiques.' : ''}
          </p>
          <div className="apply-actions">
            <button type="button" className="primary-btn" onClick={run} disabled={busy}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <Wand2 size={15} />} Prédire sur ce fichier
            </button>
            {preview && <a className="ghost-btn" href={api.scoreUrl(model.id, dataset.id)} download><Download size={15} /> Télécharger les {fmtInt(preview.total)} prédictions (CSV)</a>}
            <button type="button" className="ghost-btn" onClick={() => setSim(!sim)} aria-pressed={sim}><SlidersHorizontal size={15} /> Tester à la main</button>
          </div>
          {error && <p className="hint-warn">{error}</p>}
          {preview && (
            <>
              {preview.missing.length > 0 && (
                <p className="hint-warn"><AlertTriangle size={14} /> Colonnes absentes de ce fichier, remplacées par une valeur typique : {preview.missing.join(', ')}.
                  {preview.missing.length > model.features.length / 2 && ' Plus de la moitié des variables manquent : les prédictions sont peu fiables.'}</p>
              )}
              <div className="apply-summary">
                {preview.stats && (
                  <>
                    <div className="atelier-kpi"><span className="atelier-kpi__label">Lignes prédites</span><strong className="atelier-kpi__value">{fmtInt(preview.total)}</strong></div>
                    <div className="atelier-kpi"><span className="atelier-kpi__label">Moyenne prédite</span><strong className="atelier-kpi__value">{fmtNumber(preview.stats.mean)}</strong></div>
                    <div className="atelier-kpi"><span className="atelier-kpi__label">Minimum</span><strong className="atelier-kpi__value">{fmtNumber(preview.stats.min)}</strong></div>
                    <div className="atelier-kpi"><span className="atelier-kpi__label">Maximum</span><strong className="atelier-kpi__value">{fmtNumber(preview.stats.max)}</strong></div>
                  </>
                )}
                {preview.distribution && (
                  <>
                    <div className="atelier-kpi"><span className="atelier-kpi__label">Lignes prédites</span><strong className="atelier-kpi__value">{fmtInt(preview.total)}</strong></div>
                    {preview.distribution.slice(0, 5).map((d) => (
                      <div key={d.value} className="atelier-kpi"><span className="atelier-kpi__label">{preview.target} = {d.value}</span><strong className="atelier-kpi__value">{fmtInt(d.rows)} <small>({fmtPct(d.rows / Math.max(1, preview.total), 0)})</small></strong></div>
                    ))}
                  </>
                )}
              </div>
              <ResultTable table={preview.preview} maxRows={15} />
            </>
          )}
          {sim && <Simulator key={model.id} result={{ id: model.id, simulator: model.simulator, target: model.target }} />}
        </div>
      )}
    </div>
  )
}

const AGGS: [string, string][] = [['sum', 'Somme'], ['avg', 'Moyenne'], ['count', 'Nombre de lignes'], ['median', 'Médiane'], ['max', 'Maximum'], ['min', 'Minimum']]
const GRAINS: [string, string][] = [['day', 'Jour'], ['week', 'Semaine'], ['month', 'Mois'], ['quarter', 'Trimestre'], ['year', 'Année']]

function TimeMode({ dataset, options, onAsk }: { dataset: DatasetDetail; options: MlOptions; onAsk: (prompt: string, label: string) => void }) {
  const [date, setDate] = useState(options.dates[0] ?? '')
  const [value, setValue] = useState(options.values[0] ?? '')
  const [agg, setAgg] = useState('sum')
  const [grain, setGrain] = useState('month')
  const [periods, setPeriods] = useState(6)
  const [result, setResult] = useState<ForecastResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = () => {
    setBusy(true)
    setError(null)
    api.forecast(dataset.id, { date, value, agg, grain, periods }).then(setResult).catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  const download = () => {
    if (!result) return
    const lines = [result.table.columns.map((c) => c.name).join(';'), ...result.table.rows.map((r) => r.map((v) => String(v ?? '').replace('.', ',')).join(';'))]
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }))
    Object.assign(document.createElement('a'), { href: url, download: `prevision-${result.value}.csv` }).click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }
  const askAgent = () => {
    if (!result) return
    const board = result.models.map((m) => `- ${m.label} : erreur moyenne ${fmtNumber(m.mae)}${m.mape !== null ? `, ${fmtNumber(m.mape)} %` : ''}`).join('\n')
    const rows = result.table.rows.map((r) => `${r[0]} : ${fmtNumber(Number(r[1]))} (entre ${fmtNumber(Number(r[2]))} et ${fmtNumber(Number(r[3]))})`).join('\n')
    onAsk(`J'ai lancé une prévision de « ${result.value} » dans l'onglet Prédiction.\n${result.summary}\n\nComparaison sur les dernières périodes :\n${board}\n\nPrévision :\n${rows}\n\n` +
      'Commente cette prévision : tendance, saisonnalité visible dans les données, fiabilité et précautions d’usage.',
    `Commenter la prévision « ${result.value} »`)
  }

  if (!options.dates.length) {
    return <p className="ml-explain">Ce jeu de données n’a pas de colonne de dates reconnue : la prévision dans le temps n’est pas disponible.</p>
  }
  return (
    <>
      <div className="ml-form">
        <label className="field"><span>Indicateur</span>
          <select value={value} onChange={(e) => setValue(e.target.value)}>{options.values.map((v) => <option key={v}>{v}</option>)}</select>
        </label>
        <label className="field"><span>Calcul</span>
          <select value={agg} onChange={(e) => setAgg(e.target.value)}>{AGGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
        <label className="field"><span>Date</span>
          <select value={date} onChange={(e) => setDate(e.target.value)}>{options.dates.map((v) => <option key={v}>{v}</option>)}</select>
        </label>
        <label className="field"><span>Par</span>
          <select value={grain} onChange={(e) => setGrain(e.target.value)}>{GRAINS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
        <label className="field small"><span>Horizon</span>
          <input type="number" min={1} max={36} value={periods} onChange={(e) => setPeriods(Math.max(1, Math.min(36, Number(e.target.value) || 1)))} />
        </label>
        <button type="button" className="primary-btn" onClick={run} disabled={busy || !value || !date}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <ChartSpline size={15} />} {busy ? 'Calcul…' : 'Prévoir'}
        </button>
      </div>
      {!result && !busy && (
        <p className="ml-explain">
          DataMind agrège l’indicateur par période, compare quatre méthodes — référence naïve, tendance et saisonnalité, lissage de Holt-Winters,
          réseau de neurones — sur les dernières périodes connues, puis prolonge la série avec la plus précise.
        </p>
      )}
      {error && <p className="hint-warn">{error}</p>}
      {result && (
        <div className="ml-result">
          <div className="verdict">
            <ChartSpline size={20} aria-hidden />
            <p>{result.summary}</p>
            <button type="button" className="ghost-btn" onClick={askAgent}><MessageSquareText size={15} /> Faire commenter par l’agent</button>
          </div>
          <ChartFigure spec={result.chart} height={340} pinSource="Prévision" />
          <div className="grid-2">
            <div className="result-table leaderboard">
              <table>
                <thead><tr><th>Méthode</th><th className="num">Erreur moyenne</th><th className="num">Erreur en %</th></tr></thead>
                <tbody>
                  {result.models.map((m) => (
                    <tr key={m.kind} className={m.kind === result.best ? 'best' : undefined}>
                      <td>
                        <span className="model-name">{m.label}{m.kind === result.best && <span className="badge"><Check size={12} /> Retenue</span>}</span>
                        <span className="model-hint">{m.hint}</span>
                      </td>
                      <td className="num">{fmtNumber(m.mae)}</td>
                      <td className="num">{m.mape === null ? '—' : `${fmtNumber(m.mape)} %`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="table-note">Erreurs mesurées sur les dernières périodes, cachées aux modèles pendant l’apprentissage.</p>
            </div>
            <div>
              <ResultTable table={result.table} maxRows={36} />
              <button type="button" className="ghost-btn spaced" onClick={download}><Download size={15} /> Télécharger la prévision (CSV)</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export function Prediction({ dataset, onAsk }: { dataset: DatasetDetail; onAsk: (prompt: string, label: string) => void }) {
  const [options, setOptions] = useState<MlOptions | null>(null)
  const demo = useDemo()
  const [mode, setMode] = useState<'variable' | 'time' | 'apply'>('variable')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<SavedModel[]>([])
  const refreshSaved = () => api.savedModels().then(setSaved).catch(() => {})
  useEffect(() => {
    setOptions(null)
    api.mlOptions(dataset.id).then(setOptions).catch((e: Error) => setError(e.message))
    refreshSaved()
  }, [dataset.id])
  const noTargets = useMemo(() => options && !options.targets.length, [options])

  return (
    <div className="panel-scroll prediction">
      <div className={`ml-modes${demo ? ' two' : ''}`} role="radiogroup" aria-label="Type de prédiction">
        <button type="button" role="radio" aria-checked={mode === 'variable'} className={mode === 'variable' ? 'on' : ''} onClick={() => setMode('variable')}>
          <BrainCircuit size={16} /> <span><strong>Prévoir une variable</strong><small>Estimer une valeur ou une catégorie à partir des autres colonnes</small></span>
        </button>
        <button type="button" role="radio" aria-checked={mode === 'time'} className={mode === 'time' ? 'on' : ''} onClick={() => setMode('time')}>
          <ChartSpline size={16} /> <span><strong>Prévoir dans le temps</strong><small>Prolonger l’évolution d’un indicateur sur les prochaines périodes</small></span>
        </button>
        {!demo && (
          <button type="button" role="radio" aria-checked={mode === 'apply'} className={mode === 'apply' ? 'on' : ''} onClick={() => { setMode('apply'); refreshSaved() }}>
            <Wand2 size={16} /> <span><strong>Appliquer un modèle{saved.length > 0 && <span className="tab-count">{saved.length}</span>}</strong><small>Utiliser un modèle enregistré pour prédire les lignes de ce fichier</small></span>
          </button>
        )}
      </div>
      {error && <p className="hint-warn">{error}</p>}
      {!options && !error && <p className="ml-explain"><LoaderCircle size={15} className="spin" /> Préparation…</p>}
      {options && mode === 'variable' && (noTargets
        ? <p className="ml-explain">Aucune colonne ne peut servir de cible : il faut une colonne numérique ou une catégorie de 10 modalités au plus.</p>
        : <VariableMode key={dataset.id} dataset={dataset} options={options} onAsk={onAsk} onSaved={refreshSaved} />)}
      {options && mode === 'time' && <TimeMode key={dataset.id} dataset={dataset} options={options} onAsk={onAsk} />}
      {mode === 'apply' && !demo && <ApplyMode dataset={dataset} models={saved} onChanged={refreshSaved} />}
    </div>
  )
}
