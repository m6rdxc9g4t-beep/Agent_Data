// Onglet Assistant : fil d'analyse (question, étapes de l'agent, réponse) et zone de saisie.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AlertTriangle, ArrowUp, Check, ChevronRight, Download, LoaderCircle, Square, Zap } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { fmtInt } from '../format'
import { AnalysisIcon } from '../icons'
import type { AppConfig, Block, Conversation, QuickAnalysis, Turn } from '../types'
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

function Step({ block, n, label }: { block: ToolBlock; n: number; label: string }) {
  const [open, setOpen] = useState(false)
  const r = block.result
  const sql = (r?.sql ?? block.input.sql) as string | undefined
  const state = !r ? 'running' : r.ok ? 'ok' : 'error'
  const hasDetail = !!(sql || r?.table || r?.error || (r && !r.ok))
  return (
    <li className={`step step-${state}`}>
      <span className="step-n" aria-hidden>{state === 'running' ? <LoaderCircle size={13} className="spin" /> : n}</span>
      <div className="step-body">
        <button type="button" className="step-line" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!hasDetail}>
          <span className="step-name">{label}</span>
          <span className="step-summary">{stepSummary(block)}</span>
          {hasDetail && <ChevronRight size={14} className={open ? 'chev open' : 'chev'} aria-hidden />}
        </button>
        {open && (
          <div className="step-detail">
            {sql && <pre className="sql"><code>{sql}</code></pre>}
            {r?.error && <p className="step-error">{r.error}</p>}
            {r?.table && !r.chart && <ResultTable table={r.table} maxRows={20} />}
            {r?.table && r.chart && block.name !== 'create_chart' && <ResultTable table={r.table} maxRows={20} />}
          </div>
        )}
        {r?.ok && r.chart && <ChartFigure spec={r.chart} />}
        {r?.ok && !r.chart && r.table && block.name !== 'run_sql' && <ResultTable table={r.table} maxRows={12} />}
      </div>
    </li>
  )
}

function TurnView({ turn, labels }: { turn: Turn; labels: Record<string, string> }) {
  // Les blocs sont regroupés : suites d'étapes (trace numérotée) et paragraphes de réponse.
  const groups: (Block[])[] = []
  for (const b of turn.blocks) {
    const last = groups.at(-1)
    if (last && last[0].kind === b.kind && b.kind === 'tool') last.push(b)
    else groups.push([b])
  }
  let n = 0
  return (
    <article className="turn">
      <header className="question">
        {turn.label ? <><span className="question-kind">Analyse rapide</span><h2>{turn.label}</h2></> : <h2>{turn.question}</h2>}
      </header>
      {groups.map((g, i) => g[0].kind === 'tool'
        ? (
          <ol className="trace" key={i}>
            {(g as ToolBlock[]).map((b) => <Step key={b.id} block={b} n={++n} label={labels[b.name] ?? b.name} />)}
          </ol>
        )
        : <div className="answer" key={i}><Markdown remarkPlugins={[remarkGfm]}>{(g[0] as { text: string }).text}</Markdown></div>)}
      {turn.pending && !turn.blocks.length && <p className="thinking"><LoaderCircle size={15} className="spin" /> L’agent prépare son analyse…</p>}
      {turn.error && <p className="turn-error"><AlertTriangle size={15} /> {turn.error}</p>}
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
}

export function Assistant({ config, conversation, ready, notReadyReason, busy, engineLabel, onSend, onStop }: Props) {
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
            <div className="starters">
              {featured.map((a) => (
                <button key={a.key} type="button" className="starter" disabled={!ready} onClick={() => onSend(a.prompt, a.label)}>
                  <AnalysisIcon name={a.icon} size={18} />
                  <span><strong>{a.label}</strong><small>{a.summary}</small></span>
                </button>
              ))}
            </div>
            {!ready && <p className="hint-warn"><AlertTriangle size={15} /> {notReadyReason}</p>}
          </section>
        )}
        {turns.map((t) => <TurnView key={t.id} turn={t} labels={config.toolLabels} />)}
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
            placeholder={ready ? 'Posez une question sur vos données…' : notReadyReason}
            disabled={!ready}
            aria-label="Question"
          />
          {busy
            ? <button type="button" className="send stop" onClick={onStop} title="Arrêter l’analyse"><Square size={14} fill="currentColor" /></button>
            : <button type="button" className="send" onClick={submit} disabled={!ready || !text.trim()} title="Envoyer (Entrée)"><ArrowUp size={18} /></button>}
        </div>
        <p className="composer-note">{engineLabel} · Entrée pour envoyer, Maj + Entrée pour aller à la ligne</p>
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
  clone.querySelectorAll('.start, button.step-line svg').forEach((n) => n.remove())
  const css = `body{font:15px/1.6 system-ui,sans-serif;color:#161B2E;background:#F6F7F4;margin:0}
main{max-width:860px;margin:0 auto;padding:40px 24px}h1{font-size:26px;margin:0}header.doc{margin-bottom:28px;color:#737A8C}
.question h2{font-size:19px;margin:32px 0 10px}.question-kind{color:#3437C6;font-size:13px}
.trace{list-style:none;padding:0;margin:8px 0;border-left:2px solid #E3E5E0}.step{padding:4px 0 4px 14px}
.step-line{border:0;background:none;font:inherit;color:#4A5168;padding:0;text-align:left}.step-name{font-weight:600;margin-right:8px}
.step-n{display:none}.answer{background:#fff;border:1px solid #E3E5E0;border-radius:10px;padding:4px 20px;margin:10px 0}
.figure{background:#fff;border:1px solid #E3E5E0;border-radius:10px;padding:12px;margin:10px 0}.figure figcaption span{display:block;color:#737A8C;font-size:13px}
table{border-collapse:collapse;font-size:13px;margin:8px 0}td,th{border-bottom:1px solid #E3E5E0;padding:4px 10px;text-align:left}.num{text-align:right}
pre{background:#161B2E;color:#E7E9F0;padding:12px;border-radius:8px;overflow:auto}.turn-meta{color:#737A8C;font-size:13px}`
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — DataMind</title><style>${css}</style></head><body><main><header class="doc"><h1>${escapeHtml(title)}</h1>
Jeu de données : ${escapeHtml(datasetName)} · exporté le ${new Date().toLocaleString('fr-FR')} depuis DataMind</header>${clone.innerHTML}</main></body></html>`
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: `datamind-${slug(title)}.html` })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function ExportButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return <button type="button" className="ghost-btn" onClick={onClick} disabled={disabled}><Download size={15} /> Exporter le rapport</button>
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'analyse'
