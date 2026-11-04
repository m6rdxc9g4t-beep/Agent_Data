import { useCallback, useEffect, useRef, useState } from 'react'
import { FileSpreadsheet, Trash2, X } from 'lucide-react'

import { api, ask, type StreamEvent } from './api'
import { Assistant, exportThread, ExportButton } from './components/Assistant'
import { DataView } from './components/DataView'
import { Exploration } from './components/Exploration'
import { Quality } from './components/Quality'
import { Sidebar } from './components/Sidebar'
import { Welcome } from './components/Welcome'
import { fmtBytes, fmtInt, fmtPct, plural } from './format'
import type { AppConfig, Block, Conversation, ConversationSummary, DatasetDetail, DatasetMeta, EngineChoice, Sample, Turn } from './types'

type Tab = 'assistant' | 'exploration' | 'quality' | 'data'
const TABS: [Tab, string][] = [['assistant', 'Assistant'], ['exploration', 'Exploration'], ['quality', 'Qualité'], ['data', 'Données']]

const store = {
  get: (k: string, s: Storage = localStorage) => { try { return s.getItem(k) } catch { return null } },
  set: (k: string, v: string, s: Storage = localStorage) => { try { s.setItem(k, v) } catch { /* indisponible */ } },
}

function initialEngine(): EngineChoice {
  const saved = JSON.parse(store.get('datamind:engine') ?? '{}') as Partial<EngineChoice>
  return { engine: saved.engine ?? 'ollama', ollamaModel: saved.ollamaModel ?? '', claudeModel: saved.claudeModel ?? '', apiKey: store.get('datamind:key', sessionStorage) ?? '' }
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [samples, setSamples] = useState<Sample[]>([])
  const [datasets, setDatasets] = useState<DatasetMeta[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(store.get('datamind:dataset'))
  const [dataset, setDataset] = useState<DatasetDetail | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [engine, setEngine] = useState<EngineChoice>(initialEngine)
  const [tab, setTab] = useState<Tab>('assistant')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const abort = useRef<AbortController | null>(null)

  const fail = (e: unknown) => setToast(e instanceof Error ? e.message : String(e))
  // Date de dernière activité mise à jour sur place : la liste ne saute pas sous le curseur, elle se retrie au prochain chargement.
  const touch = (id: string, at = new Date().toISOString()) =>
    setDatasets((list) => list && list.map((d) => (d.id === id ? { ...d, lastActivityAt: at } : d)))

  const loadConfig = useCallback(() => api.config().then((c) => {
    setConfig(c)
    setEngine((e) => ({
      ...e,
      engine: store.get('datamind:engine') ? e.engine : c.defaultEngine,
      ollamaModel: c.ollama.models.includes(e.ollamaModel) ? e.ollamaModel : c.ollama.model,
      claudeModel: c.claude.models.some((m) => m.id === e.claudeModel) ? e.claudeModel : c.claude.model,
    }))
  }).catch(fail), [])

  useEffect(() => {
    loadConfig()
    api.samples().then(setSamples).catch(() => {})
    api.datasets().then(setDatasets).catch((e) => { setDatasets([]); fail(e) })
  }, [loadConfig])

  useEffect(() => {
    if (!config) return // on attend la configuration du serveur (moteur par défaut) avant de mémoriser le choix
    const { apiKey, ...rest } = engine
    store.set('datamind:engine', JSON.stringify(rest))
    store.set('datamind:key', apiKey, sessionStorage)
  }, [engine, config])

  // Jeu mémorisé qui n'existe plus (supprimé ailleurs) : on revient à l'accueil.
  useEffect(() => {
    if (datasets && activeId && !datasets.some((d) => d.id === activeId)) setActiveId(null)
  }, [datasets, activeId])

  // Jeu de données actif : détail et analyses. Ne dépend pas du contenu de la liste
  // (sa mise à jour à l'ouverture relancerait le chargement en boucle).
  const listLoaded = datasets !== null
  useEffect(() => {
    if (!listLoaded) return
    if (activeId && !datasets?.some((d) => d.id === activeId)) return // traité par l'effet précédent
    store.set('datamind:dataset', activeId ?? '')
    setDataset(null)
    setConversation(null)
    setConversations([])
    if (!activeId) return
    api.dataset(activeId).then((d) => { setDataset(d); touch(d.id, d.lastActivityAt) }).catch(fail)
    api.conversations(activeId).then((list) => {
      setConversations(list)
      if (list[0]) api.conversation(list[0].id).then(setConversation).catch(fail)
    }).catch(fail)
  }, [activeId, listLoaded])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  const addDataset = (meta: DatasetMeta) => {
    setDatasets((list) => [meta, ...(list ?? []).filter((d) => d.id !== meta.id)])
    setActiveId(meta.id)
    setTab('assistant')
  }

  const upload = async (file: File) => {
    setUploading(0)
    try {
      addDataset(await api.upload(file, setUploading))
    } catch (e) {
      fail(e)
    } finally {
      setUploading(null)
    }
  }

  const loadSample = (file: string) => {
    setUploading(1)
    api.loadSample(file).then(addDataset).catch(fail).finally(() => setUploading(null))
  }

  const deleteDataset = async () => {
    if (!dataset || !confirm(`Supprimer « ${dataset.name} » et ses analyses ? Cette action est définitive.`)) return
    await api.deleteDataset(dataset.id).catch(fail)
    setDatasets((list) => (list ?? []).filter((d) => d.id !== dataset.id))
    setActiveId(null)
  }

  const changeSheet = async (sheet: string) => {
    if (!dataset) return
    try {
      const meta = await api.selectSheet(dataset.id, sheet)
      setDatasets((list) => (list ?? []).map((d) => (d.id === meta.id ? meta : d)))
      setDataset(await api.dataset(meta.id))
    } catch (e) { fail(e) }
  }

  // ── Moteur ──────────────────────────────────────────────────────────────────────────────
  const model = engine.engine === 'claude' ? engine.claudeModel : engine.ollamaModel
  const engineStatus = !config ? { ok: false, text: 'Vérification…' }
    : engine.engine === 'claude'
      ? (config.claude.plan ? { ok: true, text: `Claude avec ton forfait, ${model}` }
        : config.claude.serverKey || engine.apiKey ? { ok: true, text: `Claude, ${model}` } : { ok: false, text: 'Claude n’est pas configuré sur le serveur.' })
      : !config.ollama.reachable ? { ok: false, text: 'Ollama injoignable. Essayez Claude ou vérifiez le serveur.' }
        : !config.ollama.models.length ? { ok: false, text: 'Aucun modèle Ollama installé.' }
          : { ok: true, text: `Ollama, ${model}` }

  // ── Conversation ────────────────────────────────────────────────────────────────────────
  const updateTurn = (turnId: string, fn: (t: Turn) => Turn) =>
    setConversation((c) => (c ? { ...c, turns: c.turns.map((t) => (t.id === turnId ? fn(t) : t)) } : c))

  const send = async (text: string, label?: string) => {
    if (!dataset || busy) return
    setTab('assistant')
    setBusy(true)
    let conv = conversation
    try {
      if (!conv) {
        conv = await api.createConversation(dataset.id)
        setConversation(conv)
      }
      const tempId = `pending-${Date.now()}`
      let turnId = tempId
      const pending: Turn = { id: tempId, question: text, label, blocks: [], engine: engine.engine, model, createdAt: new Date().toISOString(), pending: true }
      setConversation((c) => (c ? { ...c, turns: [...c.turns, pending] } : c))
      const controller = new AbortController()
      abort.current = controller
      const started = Date.now()
      const onEvent = (e: StreamEvent) => {
        switch (e.event) {
          case 'turn': {
            const old = turnId
            turnId = e.data.id
            setConversation((c) => (c ? { ...c, title: e.data.title, turns: c.turns.map((t) => (t.id === old ? { ...t, id: e.data.id } : t)) } : c))
            break
          }
          case 'text':
            updateTurn(turnId, (t) => ({ ...t, blocks: [...t.blocks, { kind: 'text', text: e.data.text }] }))
            break
          case 'tool_start':
            updateTurn(turnId, (t) => ({ ...t, blocks: [...t.blocks, { kind: 'tool', id: e.data.id, name: e.data.name, input: e.data.input }] }))
            break
          case 'tool_end':
            updateTurn(turnId, (t) => ({
              ...t,
              blocks: t.blocks.map((b): Block => (b.kind === 'tool' && b.id === e.data.id ? { ...b, result: e.data.result } : b)),
            }))
            break
          case 'done':
            updateTurn(turnId, (t) => ({ ...t, pending: false, durationMs: e.data.durationMs, usage: e.data.usage }))
            break
          case 'error':
            updateTurn(turnId, (t) => ({ ...t, pending: false, error: e.data.message }))
            break
        }
      }
      try {
        await ask(conv.id, { text, label, engine: engine.engine, model }, engine.apiKey, onEvent, controller.signal)
      } catch (err) {
        const stopped = controller.signal.aborted
        updateTurn(turnId, (t) => ({ ...t, pending: false, error: stopped ? 'Analyse arrêtée.' : err instanceof Error ? err.message : String(err) }))
      }
      updateTurn(turnId, (t) => (t.pending ? { ...t, pending: false, durationMs: Date.now() - started } : t))
      api.conversations(dataset.id).then(setConversations).catch(() => {})
      touch(dataset.id)
    } catch (e) {
      fail(e)
    } finally {
      abort.current = null
      setBusy(false)
    }
  }

  const openConversation = (id: string) => {
    if (busy) return
    api.conversation(id).then((c) => { setConversation(c); setTab('assistant') }).catch(fail)
  }
  const newConversation = () => { if (!busy) { setConversation(null); setTab('assistant') } }
  const deleteConversation = async (id: string) => {
    await api.deleteConversation(id).catch(fail)
    setConversations((l) => l.filter((c) => c.id !== id))
    if (conversation?.id === id) setConversation(null)
  }

  // ── Glisser-déposer un fichier n'importe où ─────────────────────────────────────────────
  useEffect(() => {
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDragging(true) } }
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragging(false) }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const f = e.dataTransfer?.files?.[0]
      if (f) upload(f)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop) }
  })

  const q = dataset?.profile.quality
  const nDates = dataset?.profile.columns.filter((c) => c.kind === 'datetime').length ?? 0
  const nNum = dataset?.profile.columns.filter((c) => c.kind === 'numeric').length ?? 0
  const ready = !!dataset && engineStatus.ok

  return (
    <div className="shell">
      <Sidebar
        config={config} datasets={datasets ?? []} activeId={activeId} conversations={conversations} activeConversation={conversation?.id ?? null}
        engine={engine} engineStatus={engineStatus} uploading={uploading}
        onUpload={upload} onSelectDataset={(id) => { if (!busy) setActiveId(id) }} onSelectConversation={openConversation}
        onNewConversation={newConversation} onDeleteConversation={deleteConversation} onEngine={setEngine} onRefreshConfig={loadConfig}
      />

      <main className="main">
        {!activeId && config && datasets && (
          <Welcome samples={samples} formats={config.formats} maxUploadMb={config.maxUploadMb} onUpload={upload} onSample={loadSample} busy={uploading !== null} />
        )}

        {activeId && !dataset && <div className="loading-page"><span className="spinner" /> Ouverture du jeu de données…</div>}

        {dataset && q && config && (
          <>
            <header className="ds-head">
              <div className="ds-title">
                <FileSpreadsheet size={22} strokeWidth={1.6} aria-hidden />
                <div>
                  <h1>{dataset.name}</h1>
                  <p>
                    {plural(dataset.rows, 'ligne')}, {plural(dataset.columns.length, 'colonne')} ({plural(nNum, 'numérique')}, {plural(nDates, 'date')}) · {dataset.format}, {fmtBytes(dataset.sizeBytes)}
                    {dataset.sheets.length > 1 && (
                      <> · feuille{' '}
                        <select className="inline-select" value={dataset.sheet ?? ''} onChange={(e) => changeSheet(e.target.value)} aria-label="Feuille Excel">
                          {dataset.sheets.map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </>
                    )}
                  </p>
                </div>
              </div>
              <dl className="ds-metrics">
                <div><dt>Complétude</dt><dd>{fmtPct(q.completeness)}</dd></div>
                <div><dt>Doublons</dt><dd className={q.duplicateRows ? 'warn' : undefined}>{fmtInt(q.duplicateRows)}</dd></div>
                <div><dt>Qualité</dt><dd className={q.score >= 75 ? 'good' : q.score >= 55 ? 'warn' : 'bad'}>{q.score}<small>/100</small></dd></div>
              </dl>
              <button type="button" className="icon-btn" onClick={deleteDataset} title="Supprimer ce jeu de données"><Trash2 size={16} /></button>
            </header>

            <div className="tabs" role="tablist">
              {TABS.map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
              ))}
              <span className="tabs-spacer" />
              {tab === 'assistant' && (
                <ExportButton disabled={!conversation?.turns.length || busy} onClick={() => exportThread(conversation?.title ?? 'Analyse', dataset.name)} />
              )}
            </div>

            <div className="tab-panel" hidden={tab !== 'assistant'}>
              <Assistant
                config={config} conversation={conversation} ready={ready} busy={busy}
                notReadyReason={engineStatus.ok ? '' : engineStatus.text}
                engineLabel={engineStatus.text}
                onSend={send} onStop={() => abort.current?.abort()}
              />
            </div>
            {tab === 'exploration' && <div className="tab-panel"><Exploration dataset={dataset} /></div>}
            {tab === 'quality' && (
              <div className="tab-panel">
                <Quality dataset={dataset} canAudit={ready && !busy} onAudit={() => {
                  const a = config.quickAnalyses.find((x) => x.key === 'quality')!
                  send(a.prompt, a.label)
                }} />
              </div>
            )}
            {tab === 'data' && <div className="tab-panel"><DataView dataset={dataset} /></div>}
          </>
        )}
      </main>

      {dragging && <div className="drop-overlay"><div>Déposez le fichier pour l’importer</div></div>}
      {toast && (
        <div className="toast" role="alert">
          <span>{toast}</span>
          <button type="button" className="icon-btn small" onClick={() => setToast(null)} aria-label="Fermer"><X size={14} /></button>
        </div>
      )}
    </div>
  )
}
