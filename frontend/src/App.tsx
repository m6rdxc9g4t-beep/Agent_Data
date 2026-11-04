import { useCallback, useEffect, useRef, useState } from 'react'
import { FileSpreadsheet, Menu, Trash2, X } from 'lucide-react'

import { api, ask, type StreamEvent } from './api'
import { Assistant, exportThread, ExportButton } from './components/Assistant'
import { Dashboard } from './components/Dashboard'
import { DataView } from './components/DataView'
import { Exploration } from './components/Exploration'
import { LinkBar, LinkDialog } from './components/Links'
import { Prediction } from './components/Prediction'
import { Quality } from './components/Quality'
import { SampleDialog } from './components/SampleGallery'
import { Sidebar } from './components/Sidebar'
import { Welcome } from './components/Welcome'
import { fmtBytes, fmtInt, fmtPct, plural } from './format'
import { PinProviderValue } from './pins'
import type { AppConfig, Block, Conversation, ConversationSummary, DatasetDetail, DatasetMeta, EngineChoice, LinkInfo, NewPin, Pin, Sample, Turn } from './types'

type Tab = 'assistant' | 'dashboard' | 'exploration' | 'prediction' | 'quality' | 'data'
const TABS: [Tab, string][] = [['assistant', 'Assistant'], ['dashboard', 'Tableau de bord'], ['exploration', 'Exploration'], ['prediction', 'Prédiction'], ['quality', 'Qualité'], ['data', 'Données']]

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
  const [pins, setPins] = useState<Pin[]>([])
  const [links, setLinks] = useState<LinkInfo[]>([])
  const [showLink, setShowLink] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [engine, setEngine] = useState<EngineChoice>(initialEngine)
  const [tab, setTab] = useState<Tab>('assistant')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [showSamples, setShowSamples] = useState(false)
  const [sampleBusy, setSampleBusy] = useState<string | null>(null)
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
    refreshSamples()
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
    setPins([])
    setLinks([])
    if (!activeId) return
    api.pins(activeId).then(setPins).catch(() => {})
    api.links(activeId).then(setLinks).catch(() => {})
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

  const refreshSamples = () => api.samples().then(setSamples).catch(() => {})
  const loadSample = (s: Sample) => {
    if (busy) return
    setShowSamples(false)
    if (s.datasetId && datasets?.some((d) => d.id === s.datasetId)) {
      setActiveId(s.datasetId)
      setTab('assistant')
      return
    }
    setSampleBusy(s.file)
    api.loadSample(s.file).then((meta) => { addDataset(meta); refreshSamples() }).catch(fail).finally(() => setSampleBusy(null))
  }

  const deleteDataset = async () => {
    if (!dataset || !confirm(`Supprimer « ${dataset.name} » et ses analyses ? Cette action est définitive.`)) return
    await api.deleteDataset(dataset.id).catch(fail)
    setDatasets((list) => (list ?? []).filter((d) => d.id !== dataset.id))
    setActiveId(null)
    refreshSamples()
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

  const claudeReady = !!config && (config.claude.plan || config.claude.serverKey || !!engine.apiKey)
  const ollamaReady = !!config && config.ollama.reachable && config.ollama.models.length > 0
  const fallback = engineStatus.ok || !config ? undefined
    : engine.engine === 'ollama' && claudeReady ? { label: 'Utiliser Claude', onClick: () => setEngine((e) => ({ ...e, engine: 'claude' })) }
      : engine.engine === 'claude' && ollamaReady ? { label: 'Utiliser Ollama', onClick: () => setEngine((e) => ({ ...e, engine: 'ollama' })) }
        : undefined

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

  // ── Fichiers liés ───────────────────────────────────────────────────────────────────────
  const saveLinks = async (next: { id: string; table: string }[]) => {
    if (!dataset) return
    const meta = await api.saveLinks(dataset.id, next)
    setDataset((d) => (d ? { ...d, links: meta.links } : d))
    setLinks(await api.links(dataset.id))
  }
  const addLink = async (otherId: string, table: string) => {
    await saveLinks([...links.map(({ id, table: t }) => ({ id, table: t })), { id: otherId, table }])
    setShowLink(false)
  }
  const removeLink = (l: LinkInfo) => {
    saveLinks(links.filter((x) => x.id !== l.id).map(({ id, table }) => ({ id, table }))).catch(fail)
  }
  const ideas = [
    ...links.map((l) => `Croiser avec « ${l.name} » (table ${l.table}) : qu’apprend-on ?`),
    ...((dataset?.sample ? samples.find((s) => s.file === dataset.fileName)?.ideas : undefined) ?? []),
  ]

  // ── Tableau de bord ─────────────────────────────────────────────────────────────────────
  const pinApi = {
    pins,
    add: (pin: NewPin) => {
      if (!dataset) return
      api.addPin(dataset.id, pin).then((p) => setPins((l) => (l.some((x) => x.id === p.id) ? l : [...l, p]))).catch(fail)
    },
    remove: (key: string) => {
      const p = pins.find((x) => x.key === key)
      if (dataset && p) removePin(p)
    },
  }
  const removePin = (p: Pin) => {
    if (!dataset) return
    setPins((l) => l.filter((x) => x.id !== p.id))
    api.removePin(dataset.id, p.id).catch(fail)
  }
  const updatePin = (p: Pin, patch: { title?: string; note?: string; wide?: boolean }) => {
    if (!dataset) return
    setPins((l) => l.map((x) => (x.id === p.id ? { ...x, ...patch } : x)))
    api.updatePin(dataset.id, p.id, patch).catch(fail)
  }
  const movePin = (p: Pin, delta: -1 | 1) => {
    if (!dataset) return
    const i = pins.findIndex((x) => x.id === p.id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= pins.length) return
    const next = [...pins]
    ;[next[i], next[j]] = [next[j], next[i]]
    setPins(next)
    api.orderPins(dataset.id, next.map((x) => x.id)).catch(fail)
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
        onUpload={(f) => { setNavOpen(false); upload(f) }} onOpenSamples={() => { refreshSamples(); setShowSamples(true); setNavOpen(false) }}
        onSelectDataset={(id) => { if (!busy) { setActiveId(id); setNavOpen(false) } }}
        onSelectConversation={(id) => { openConversation(id); setNavOpen(false) }}
        onNewConversation={() => { newConversation(); setNavOpen(false) }} onDeleteConversation={deleteConversation} onEngine={setEngine} onRefreshConfig={loadConfig}
        open={navOpen} onClose={() => setNavOpen(false)}
      />
      {navOpen && <div className="drawer-backdrop" onClick={() => setNavOpen(false)} aria-hidden />}

      <main className="main">
        <header className="mobile-bar">
          <button type="button" className="icon-btn" onClick={() => setNavOpen(true)} aria-label="Ouvrir le menu"><Menu size={20} /></button>
          <img src="/logo.svg" alt="" width={24} height={24} />
          <strong>{dataset?.name ?? 'DataMind'}</strong>
          <span className={`dot ${engineStatus.ok ? 'ok' : 'warn'}`} title={engineStatus.text} />
        </header>
        {!activeId && config && datasets && (
          <Welcome samples={samples} formats={config.formats} maxUploadMb={config.maxUploadMb} onUpload={upload} onSample={loadSample}
            busy={uploading !== null || sampleBusy !== null} busyFile={sampleBusy} />
        )}

        {activeId && !dataset && <div className="loading-page"><span className="spinner" /> Ouverture du jeu de données…</div>}

        {dataset && q && config && (
          <PinProviderValue value={pinApi}>
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
                  {dataset.cleanedFrom && (
                    <p className="cleaned-from">Version nettoyée de{' '}
                      {datasets?.some((d) => d.id === dataset.cleanedFrom)
                        ? <button type="button" className="link-btn" onClick={() => setActiveId(dataset.cleanedFrom!)}>« {datasets.find((d) => d.id === dataset.cleanedFrom)!.name} »</button>
                        : 'un jeu supprimé'}
                    </p>
                  )}
                  <LinkBar dataset={dataset} links={links} onAdd={() => setShowLink(true)} onRemove={removeLink} />
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
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                  {label}{k === 'dashboard' && pins.length > 0 && <span className="tab-count">{pins.length}</span>}
                </button>
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
                ideas={ideas} datasetId={dataset.id} fallback={fallback}
                onSend={send} onStop={() => abort.current?.abort()}
              />
            </div>
            {tab === 'exploration' && <div className="tab-panel"><Exploration dataset={dataset} /></div>}
            <div className="tab-panel" hidden={tab !== 'prediction'}>
              <Prediction dataset={dataset} onAsk={(prompt, label) => send(prompt, label)} />
            </div>
            {tab === 'quality' && (
              <div className="tab-panel">
                <Quality dataset={dataset} canAudit={ready && !busy}
                  onPatched={(m) => setDataset((d) => (d && d.id === m.id ? { ...d, descriptions: m.descriptions, context: m.context } : d))}
                  onCleaned={(m) => setDatasets((list) => [m, ...(list ?? []).filter((d) => d.id !== m.id)])}
                  onOpen={(id) => { if (!busy) { setActiveId(id); setTab('quality') } }}
                  onAudit={() => {
                  const a = config.quickAnalyses.find((x) => x.key === 'quality')!
                  send(a.prompt, a.label)
                }} />
              </div>
            )}
            {tab === 'data' && <div className="tab-panel"><DataView dataset={dataset} /></div>}
            {tab === 'dashboard' && (
              <div className="tab-panel"><Dashboard dataset={dataset} pins={pins} onUpdate={updatePin} onRemove={removePin} onMove={movePin} /></div>
            )}
          </PinProviderValue>
        )}
      </main>

      {showLink && dataset && (
        <LinkDialog dataset={dataset} datasets={datasets ?? []} links={links} onClose={() => setShowLink(false)} onSave={addLink} />
      )}
      {showSamples && <SampleDialog samples={samples} onPick={loadSample} onClose={() => setShowSamples(false)} busyFile={sampleBusy} />}
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
