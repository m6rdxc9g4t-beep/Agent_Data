// Onglet Assistant : fil d'analyse (question, étapes de l'agent, réponse) et zone de saisie.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AlertTriangle, ArrowRight, ArrowUp, Check, ChevronRight, Download, LoaderCircle, Pencil, Play, RotateCcw, Sparkles, Square, Zap } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { api } from '../api'
import { fmtInt } from '../format'
import { AnalysisIcon } from '../icons'
import type { AppConfig, Block, Conversation, QuickAnalysis, TableData, Turn } from '../types'
import { PinButton, tablePin, textPin } from '../pins'
import { ChartFigure } from './Chart'
import { ResultTable } from './ResultTable'

type ToolBlock = Extract<Block, { kind: 'tool' }>

function stepSummary(b: ToolBlock): string {
  if (!b.result) return 'en cours…'
  if (!b.result.ok) return 'erreur, l’agent corrige'
  if (b.result.chart) return b.result.chart.title
  if (b.result.table) return `${fmtInt(b.result.table.rows.length)}${b.result.table.truncated ? '+' : ''} ligne(s)`
  return 'terminé'
}

/** Requête d'une étape, modifiable et relançable sur les données (lecture seule). */
function SqlEditor({ sql, datasetId, source }: { sql: string; datasetId: string; source: string }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(sql)
  const [result, setResult] = useState<(TableData & { durationMs: number }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = () => {
    setBusy(true); setError(null)
    api.query(datasetId, text).then(setResult).catch((e: Error) => { setError(e.message); setResult(null) }).finally(() => setBusy(false))
  }
  if (!editing) {
    return (
      <div className="sql-wrap">
        <pre className="sql"><code>{sql}</code></pre>
        <button type="button" className="sql-edit" onClick={() => setEditing(true)} title="Modifier et relancer cette requête"><Pencil size={13} /> Modifier</button>
      </div>
    )
  }
  return (
    <div className="sql-editor">
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={Math.min(14, text.split('\n').length + 1)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run() } }} aria-label="Requête SQL" />
      <div className="sql-actions">
        <button type="button" className="primary-btn small" onClick={run} disabled={busy || !text.trim()}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />} Exécuter
        </button>
        <button type="button" className="ghost-btn small" onClick={() => { setText(sql); setResult(null); setError(null) }} disabled={text === sql && !result}>
          <RotateCcw size={14} /> Requête d’origine
        </button>
        <button type="button" className="ghost-btn small" onClick={() => setEditing(false)}>Fermer</button>
        <span className="muted">Ctrl + Entrée pour exécuter · lecture seule</span>
      </div>
      {error && <p className="step-error">{error}</p>}
      {result && (
        <>
          <ResultTable table={result} maxRows={50} />
          <div className="sql-result-meta">
            <span className="muted">{fmtInt(result.rows.length)}{result.truncated ? '+' : ''} ligne(s) en {result.durationMs} ms</span>
            <PinButton pin={tablePin(result, `${source} (requête modifiée)`, source, text)} />
          </div>
        </>
      )}
    </div>
  )
}

function Step({ block, n, label, source, datasetId }: { block: ToolBlock; n: number; label: string; source: string; datasetId: string }) {
  const [open, setOpen] = useState(false)
  const r = block.result
  const sql = (r?.sql ?? block.input.sql) as string | undefined
  const state = !r ? 'running' : r.ok ? 'ok' : 'error'
  const hasDetail = !!(sql || r?.table || r?.error || (r && !r.ok))
  return (
    <li className={`step step-${state}`}>
      <span className="step-n" aria-hidden>{state === 'running' ? <LoaderCircle size={12} className="spin" /> : state === 'error' ? <AlertTriangle size={11} /> : n}</span>
      <div className="step-body">
        <button type="button" className="step-line" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!hasDetail}>
          <span className="step-name">{label}</span>
          <span className="step-summary">{stepSummary(block)}</span>
          {hasDetail && <ChevronRight size={14} className={open ? 'chev open' : 'chev'} aria-hidden />}
        </button>
        {open && (
          <div className="step-detail">
            {sql && <SqlEditor sql={sql} datasetId={datasetId} source={source} />}
            {r?.error && <p className="step-error">{r.error}</p>}
            {r?.table && !r.chart && (
              <>
                <ResultTable table={r.table} maxRows={20} />
                <PinButton pin={tablePin(r.table, label === 'Requête SQL' ? source : label, source, sql)} />
              </>
            )}
            {r?.table && r.chart && block.name !== 'create_chart' && <ResultTable table={r.table} maxRows={20} />}
          </div>
        )}
        {r?.ok && r.chart && <ChartFigure spec={r.chart} pinSource={source} sql={sql} />}
        {r?.ok && !r.chart && r.table && block.name !== 'run_sql' && (
          <div className="pinnable">
            <PinButton pin={tablePin(r.table, r.summary.split('\n')[0].slice(0, 120) || label, source, sql)} compact />
            <ResultTable table={r.table} maxRows={12} />
          </div>
        )}
      </div>
    </li>
  )
}

/** Sépare la section « Pour aller plus loin » (questions de relance) du reste de la réponse. */
export function splitFollowUps(text: string): { body: string; followUps: string[] } {
  const m = /\n?(?:#{1,4}\s*|\*\*)?\s*Pour aller plus loin\s*(?:\*\*)?\s*:?\s*(?:\*\*)?\s*\n((?:\s*(?:[-*•]|\d+[.)])\s+.+\n?){1,6})\s*$/i.exec(text)
  if (!m) return { body: text, followUps: [] }
  const followUps = m[1].split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/\*\*/g, '').replace(/^[«"“]\s*|\s*[»"”]$/g, '').trim())
    .filter((l) => l.length > 3).slice(0, 4)
  return { body: text.slice(0, m.index).trimEnd(), followUps }
}

function TurnView({ turn, labels, datasetId, onFollowUp }: {
  turn: Turn; labels: Record<string, string>; datasetId: string; onFollowUp?: (q: string) => void
}) {
  // Les blocs sont regroupés : suites d'étapes (trace numérotée) et paragraphes de réponse.
  const groups: (Block[])[] = []
  const lastText = turn.blocks.findLastIndex((b) => b.kind === 'text')
  let followUps: string[] = []
  for (const [bi, b0] of turn.blocks.entries()) {
    let b = b0
    if (bi === lastText && !turn.pending && b.kind === 'text') {
      const split = splitFollowUps(b.text)
      followUps = split.followUps
      b = { kind: 'text', text: split.body }
    }
    const last = groups.at(-1)
    if (last && last[0].kind === b.kind && b.kind === 'tool') last.push(b)
    else groups.push([b])
  }
  let n = 0
  return (
    <article className="turn">
      <header className="question">
        <h2>{turn.label ?? turn.question}</h2>
        {turn.label && <span className="question-kind"><Zap size={12} aria-hidden /> Analyse rapide</span>}
      </header>
      <div className="reply-head">
        <span className="atelier-brand__tile atelier-brand__tile--sm" aria-hidden><Sparkles /></span>
        <strong>DataMind</strong>
        {turn.pending && <span className="reply-state"><LoaderCircle size={12} className="spin" aria-hidden /> en cours</span>}
      </div>
      {groups.map((g, i) => g[0].kind === 'tool'
        ? (
          <ol className="trace" key={i}>
            {(g as ToolBlock[]).map((b) => <Step key={b.id} block={b} n={++n} label={labels[b.name] ?? b.name} source={turn.label ?? turn.question} datasetId={datasetId} />)}
          </ol>
        )
        : (
          <div className="answer" key={i}>
            {!turn.pending && <PinButton pin={textPin((g[0] as { text: string }).text, turn.label ?? turn.question, 'Réponse de l’agent')} compact />}
            <Markdown remarkPlugins={[remarkGfm]}>{(g[0] as { text: string }).text}</Markdown>
          </div>
        ))}
      {turn.pending && !turn.blocks.length && <p className="thinking"><LoaderCircle size={15} className="spin" /> L’agent prépare son analyse…</p>}
      {turn.error && <p className="turn-error"><AlertTriangle size={15} /> {turn.error}</p>}
      {followUps.length > 0 && (
        <div className="followups">
          <span>Pour aller plus loin</span>
          <div>
            {followUps.map((q) => (
              <button key={q} type="button" className="idea" disabled={!onFollowUp} onClick={() => onFollowUp?.(q)}>
                {q} <ArrowRight size={13} />
              </button>
            ))}
          </div>
        </div>
      )}
      {!turn.pending && !turn.error && turn.durationMs !== undefined && (
        <footer className="turn-meta">
          <Check size={13} aria-hidden /> {n} étape{n > 1 ? 's' : ''} en {(turn.durationMs / 1000).toFixed(1).replace('.', ',')} s, {turn.model}
        </footer>
      )}
    </article>
  )
}

function QuickMenu({ analyses, onPick, disabled }: { analyses: QuickAnalysis[]; onPick: (a: QuickAnalysis) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const groups = [...new Set(analyses.map((a) => a.group))]
  return (
    <div className="quick-menu" ref={ref}>
      <button type="button" className="icon-btn" onClick={() => setOpen(!open)} disabled={disabled} aria-expanded={open} title="Analyses rapides">
        <Zap size={17} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {groups.map((g) => (
            <div key={g} className="menu-group">
              <p>{g}</p>
              {analyses.filter((a) => a.group === g).map((a) => (
                <button key={a.key} role="menuitem" type="button" onClick={() => { setOpen(false); onPick(a) }}>
                  <AnalysisIcon name={a.icon} size={15} /> {a.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface Props {
  config: AppConfig
  conversation: Conversation | null
  ready: boolean
  notReadyReason: string
  busy: boolean
  engineLabel: string
  onSend: (text: string, label?: string) => void
  onStop: () => void
  ideas?: string[]
  datasetId: string
  /** Autre moteur disponible quand celui choisi ne répond pas. */
  fallback?: { label: string; onClick: () => void }
}

export function Assistant({ config, conversation, ready, notReadyReason, busy, engineLabel, ideas, datasetId, fallback, onSend, onStop }: Props) {
  const [text, setText] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const thread = useRef<HTMLDivElement>(null)
  const turns = conversation?.turns ?? []
  const featured = useMemo(() => config.featured.map((k) => config.quickAnalyses.find((a) => a.key === k)!).filter(Boolean), [config])

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const lastTurn = turns.at(-1)
  useEffect(() => {
    if (!turns.length) return // écran d'accueil de l'Assistant : on garde son titre en vue
    thread.current?.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [turns.length, lastTurn?.blocks.length, lastTurn?.pending])

  const submit = () => {
    const t = text.trim()
    if (!t || !ready || busy) return
    onSend(t)
    setText('')
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="assistant">
      <div className="thread" ref={thread} id="thread">
        {turns.length === 0 && (
          <section className="start">
            <h2>Que voulez-vous savoir sur ces données ?</h2>
            <p>Posez une question en français ou lancez une analyse. L’agent écrit des requêtes, les exécute sur vos données et vous montre chaque étape.</p>
            {!ready && (
              <div className="hint-warn" role="status">
                <AlertTriangle size={15} aria-hidden />
                <p><strong>Moteur IA indisponible</strong> {notReadyReason}</p>
                {fallback && <button type="button" className="ghost-btn small" onClick={fallback.onClick}>{fallback.label}</button>}
              </div>
            )}
            <div className="starters">
              {featured.map((a) => (
                <button key={a.key} type="button" className="starter" disabled={!ready} onClick={() => onSend(a.prompt, a.label)}>
                  <AnalysisIcon name={a.icon} size={18} />
                  <span><strong>{a.label}</strong><small>{a.summary}</small></span>
                </button>
              ))}
            </div>
            {ideas && ideas.length > 0 && (
              <div className="ideas">
                <span>Questions suggérées</span>
                <div>
                  {ideas.map((q) => (
                    <button key={q} type="button" className="idea" disabled={!ready} onClick={() => onSend(q)}>{q}</button>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
        {turns.map((t, i) => (
          <TurnView key={t.id} turn={t} labels={config.toolLabels} datasetId={datasetId}
            onFollowUp={i === turns.length - 1 && ready && !busy ? (q) => onSend(q) : undefined} />
        ))}
      </div>

      <div className="composer-wrap">
        <div className={`composer${ready ? '' : ' disabled'}`}>
          <QuickMenu analyses={config.quickAnalyses} disabled={!ready || busy} onPick={(a) => onSend(a.prompt, a.label)} />
          <textarea
            ref={area}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={ready ? 'Posez une question sur vos données…' : 'Moteur IA indisponible : voir « Moteur IA » dans le menu'}
            disabled={!ready}
            aria-label="Question"
          />
          {busy
            ? <button type="button" className="send stop" onClick={onStop} title="Arrêter l’analyse"><Square size={14} fill="currentColor" /></button>
            : <button type="button" className="send" onClick={submit} disabled={!ready || !text.trim()} title="Envoyer (Entrée)"><ArrowUp size={18} /></button>}
        </div>
        {ready && <p className="composer-note">{engineLabel} · Entrée pour envoyer, Maj + Entrée pour aller à la ligne</p>}
      </div>
    </div>
  )
}

/** Exporte le fil affiché en page HTML autonome (graphiques convertis en images). */
export function exportThread(title: string, datasetName: string) {
  const src = document.getElementById('thread')
  if (!src) return
  const clone = src.cloneNode(true) as HTMLElement
  const canvases = src.querySelectorAll('canvas')
  clone.querySelectorAll('canvas').forEach((c, i) => {
    const img = document.createElement('img')
    img.src = (canvases[i] as HTMLCanvasElement).toDataURL('image/png')
    img.style.width = '100%'
    c.replaceWith(img)
  })
  clone.querySelectorAll('.start, button.step-line svg, .pin-btn, .followups').forEach((n) => n.remove())
  const css = `body{font:14px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1a1b1e;background:#fbfbfc;margin:0}
main{max-width:820px;margin:0 auto;padding:40px 24px}h1{font-size:20px;font-weight:600;margin:0}header.doc{margin-bottom:28px;color:#5f636c}
.question{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin:32px 0 10px}.question h2{font-size:15px;font-weight:600;margin:0}
.question-kind{color:#5f636c;font-size:12px}.question-kind svg,.reply-head svg,.atelier-brand__tile{display:none}
.reply-head{font-size:13px;color:#5f636c;margin:0 0 6px}.reply-state{display:none}
.trace{list-style:none;padding:0;margin:8px 0;border-left:1px solid #e3e4e8}.step{padding:3px 0 3px 14px}
.step-line{border:0;background:none;font:inherit;color:#393c42;padding:0;text-align:left}.step-name{font-weight:500;margin-right:8px}
.step-summary{color:#5f636c}.step-n{display:none}.answer{margin:10px 0}
.figure{background:#fff;border:1px solid #e3e4e8;border-radius:10px;padding:12px;margin:10px 0}.figure figcaption strong{font-weight:600}.figure figcaption span{display:block;color:#5f636c;font-size:12.5px}
table{border-collapse:collapse;font-size:13px;margin:8px 0;font-variant-numeric:tabular-nums}td,th{border-bottom:1px solid #e3e4e8;padding:5px 10px;text-align:left}th{font-weight:500;color:#5f636c}.num{text-align:right}
pre{background:#f4f5f7;border:1px solid #e3e4e8;color:#1a1b1e;padding:10px 12px;border-radius:7px;overflow:auto;font:12.5px/1.55 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.9em}.turn-meta{color:#6c7079;font-size:12px}.turn-meta svg{display:none}`
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — DataMind</title><style>${css}</style></head><body><main><header class="doc"><h1>${escapeHtml(title)}</h1>
Jeu de données : ${escapeHtml(datasetName)} · exporté le ${new Date().toLocaleString('fr-FR')} depuis DataMind</header>${clone.innerHTML}</main></body></html>`
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: `datamind-${slug(title)}.html` })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function ExportButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return <button type="button" className="ghost-btn" onClick={onClick} disabled={disabled}><Download size={15} /> <span className="btn-label">Exporter le rapport</span></button>
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'analyse'
