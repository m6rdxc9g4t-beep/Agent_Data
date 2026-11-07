import { useCallback, useEffect, useRef, useState } from 'react'
import { FileSpreadsheet, Menu, Trash2, X } from 'lucide-react'

import { api, ask, type StreamEvent } from './api'
import { Assistant, exportThread, ExportButton } from './components/Assistant'
import { Dashboard } from './components/Dashboard'
import { DemoBanner } from './components/DemoBanner'
import { DataView } from './components/DataView'
import { Exploration } from './components/Exploration'
import { LinkBar, LinkDialog } from './components/Links'
import { Prediction } from './components/Prediction'
import { Quality } from './components/Quality'
import { SampleDialog } from './components/SampleGallery'
import { BrandTile } from './components/Brand'
import { Sidebar } from './components/Sidebar'
import { Welcome } from './components/Welcome'
import { DemoContext } from './demo'
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
  // Démo publique : rien n'est écrit sur le serveur ; le tableau de bord reste dans cet onglet du navigateur.
  const demo = !!config?.demo
  const localPins = useRef(new Map<string, Pin[]>())

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
    if (!config || config.demo) return // on attend la configuration du serveur (moteur par défaut) avant de mémoriser le choix
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
    if (demo) setPins(localPins.current.get(activeId) ?? [])
    else {
      api.pins(activeId).then(setPins).catch(() => {})
      api.links(activeId).then(setLinks).catch(() => {})
    }
    api.dataset(activeId).then((d) => { setDataset(d); touch(d.id, d.lastActivityAt) }).catch(fail)
    api.conversations(activeId).then((list) => {
      setConversations(list)
      if (list[0]) api.conversation(list[0].id).then(setConversation).catch(fail)
    }).catch(fail)
  }, [activeId, listLoaded, demo])

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
    if (demo) return
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
  // Démo : l'IA du serveur seulement (Ollama, modèle choisi par le serveur), jamais Claude.
  const choice: EngineChoice = config?.demo ? { engine: 'ollama', ollamaModel: config.ollama.model, claudeModel: '', apiKey: '' } : engine
  const model = choice.engine === 'claude' ? choice.claudeModel : choice.ollamaModel
  const engineStatus = !config ? { ok: false, text: 'Vérification…' }
    : choice.engine === 'claude'
      ? (config.claude.plan ? { ok: true, text: `Claude avec ton forfait, ${model}` }
        : config.claude.serverKey || choice.apiKey ? { ok: true, text: `Claude, ${model}` } : { ok: false, text: 'Claude n’est pas configuré sur le serveur.' })
      : !config.ollama.reachable ? { ok: false, text: config.demo ? 'L’IA du serveur ne répond pas pour le moment.' : 'Ollama injoignable. Essayez Claude ou vérifiez le serveur.' }
        : !config.ollama.models.length ? { ok: false, text: 'Aucun modèle Ollama installé.' }
          : { ok: true, text: config.demo ? `IA du serveur (Ollama), ${model}` : `Ollama, ${model}` }

  const claudeReady = !!config && !config.demo && (config.claude.plan || config.claude.serverKey || !!choice.apiKey)
  const ollamaReady = !!config && config.ollama.reachable && config.ollama.models.length > 0
  const fallback = engineStatus.ok || !config ? undefined
    : choice.engine === 'ollama' && claudeReady ? { label: 'Utiliser Claude', onClick: () => setEngine((e) => ({ ...e, engine: 'claude' })) }
      : choice.engine === 'claude' && ollamaReady ? { label: 'Utiliser Ollama', onClick: () => setEngine((e) => ({ ...e, engine: 'ollama' })) }
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
      const pending: Turn = { id: tempId, question: text, label, blocks: [], engine: choice.engine, model, createdAt: new Date().toISOString(), pending: true }
      setConversation((c) => (c ? { ...c, turns: [...c.turns, pending] } : c))
      const controller = new AbortController()
      abort.current = controller
      const started = Date.now()
      const onEvent = (e: StreamEvent) => {
        switch (e.event) {
          case 'queued':
            updateTurn(turnId, (t) => ({ ...t, queued: e.data.message }))
            break
          case 'turn': {
            const old = turnId
            turnId = e.data.id
            setConversation((c) => (c ? { ...c, title: e.data.title, turns: c.turns.map((t) => (t.id === old ? { ...t, id: e.data.id } : t)) } : c))
            break
          }
          case 'text':
            updateTurn(turnId, (t) => ({ ...t, queued: undefined, blocks: [...t.blocks, { kind: 'text', text: e.data.text }] }))
            break
          case 'tool_start':
            updateTurn(turnId, (t) => ({ ...t, queued: undefined, blocks: [...t.blocks, { kind: 'tool', id: e.data.id, name: e.data.name, input: e.data.input }] }))
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
        await ask(conv.id, { text, label, engine: choice.engine, model }, choice.apiKey, onEvent, controller.signal)
      } catch (err) {
        const stopped = controller.signal.aborted
        updateTurn(turnId, (t) => ({ ...t, pending: false, error: stopped ? 'Analyse arrêtée.' : err instanceof Error ? err.message : String(err) }))
      }
      updateTurn(turnId, (t) => (t.pending ? { ...t, pending: false, queued: undefined, durationMs: Date.now() - started } : { ...t, queued: undefined }))
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
  /** Modifie la liste des éléments épinglés (et, en démo, la copie gardée dans le navigateur pour ce jeu). */
  const changePins = (datasetId: string, fn: (l: Pin[]) => Pin[]) => setPins((l) => {
    const next = fn(l)
    if (demo) localPins.current.set(datasetId, next)
    return next
  })
  const pinApi = {
    pins,
    add: (pin: NewPin) => {
      if (!dataset) return
      if (demo) {
        const id = dataset.id
        changePins(id, (l) => {
          if (l.some((x) => x.key === pin.key)) return l
          if (l.length >= 60) { fail('Tableau de bord plein (60 éléments) : retirez-en avant d’en ajouter.'); return l }
          const wide = pin.kind === 'table' || pin.kind === 'text' ? true : !!pin.wide
          return [...l, { ...pin, wide, id: `local-${Date.now().toString(36)}-${l.length}`, createdAt: new Date().toISOString() }]
        })
        return
      }
      api.addPin(dataset.id, pin).then((p) => setPins((l) => (l.some((x) => x.id === p.id) ? l : [...l, p]))).catch(fail)
    },
    remove: (key: string) => {
      const p = pins.find((x) => x.key === key)
      if (dataset && p) removePin(p)
    },
  }
  const removePin = (p: Pin) => {
    if (!dataset) return
    changePins(dataset.id, (l) => l.filter((x) => x.id !== p.id))
    if (!demo) api.removePin(dataset.id, p.id).catch(fail)
  }
  const updatePin = (p: Pin, patch: { title?: string; note?: string; wide?: boolean }) => {
    if (!dataset) return
    changePins(dataset.id, (l) => l.map((x) => (x.id === p.id ? { ...x, ...patch } : x)))
    if (!demo) api.updatePin(dataset.id, p.id, patch).catch(fail)
  }
  const movePin = (p: Pin, delta: -1 | 1) => {
    if (!dataset) return
    const i = pins.findIndex((x) => x.id === p.id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= pins.length) return
    const next = [...pins]
    ;[next[i], next[j]] = [next[j], next[i]]
    changePins(dataset.id, () => next)
    if (!demo) api.orderPins(dataset.id, next.map((x) => x.id)).catch(fail)
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
    if (demo) return // pas d'import dans la démo
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
    <DemoContext.Provider value={demo}>
    <div className="shell">
      <Sidebar
        config={config} datasets={datasets ?? []} activeId={activeId} conversations={conversations} activeConversation={conversation?.id ?? null}
        engine={choice} engineStatus={engineStatus} uploading={uploading}
        onUpload={(f) => { setNavOpen(false); upload(f) }} onOpenSamples={() => { refreshSamples(); setShowSamples(true); setNavOpen(false) }}
        onSelectDataset={(id) => { if (!busy) { setActiveId(id); setNavOpen(false) } }}
        onSelectConversation={(id) => { openConversation(id); setNavOpen(false) }}
        onNewConversation={() => { newConversation(); setNavOpen(false) }} onDeleteConversation={deleteConversation} onEngine={setEngine} onRefreshConfig={loadConfig}
        open={navOpen} onClose={() => setNavOpen(false)}
      />
      {navOpen && <div className="drawer-backdrop" onClick={() => setNavOpen(false)} aria-hidden />}

      <main className="main">
        {config?.demo && <DemoBanner returnUrl={config.demo.returnUrl} />}
        {!dataset && (
          <header className="topbar">
            <button type="button" className="icon-btn menu-btn" onClick={() => setNavOpen(true)} aria-label="Ouvrir le menu"><Menu size={18} /></button>
            <BrandTile />
            <h1 className="topbar-title">{activeId ? 'Ouverture…' : 'Accueil'}</h1>
            {!engineStatus.ok && config && <span className="dot warn" title={engineStatus.text} />}
          </header>
        )}
        {!activeId && config && datasets && (
          <Welcome samples={samples} formats={config.formats} maxUploadMb={config.maxUploadMb} onUpload={upload} onSample={loadSample}
            busy={uploading !== null || sampleBusy !== null} busyFile={sampleBusy} />
        )}

        {activeId && !dataset && <div className="loading-page"><span className="spinner" /> Ouverture du jeu de données…</div>}

        {dataset && q && config && (
          <PinProviderValue value={pinApi}>
            <header className="topbar ds-head">
              <button type="button" className="icon-btn menu-btn" onClick={() => setNavOpen(true)} aria-label="Ouvrir le menu"><Menu size={18} /></button>
              <FileSpreadsheet className="ds-icon" size={16} strokeWidth={1.75} aria-hidden />
              <h1 className="topbar-title" title={dataset.name}>{dataset.name}</h1>
              <p className="ds-meta">
                {plural(dataset.rows, 'ligne')}, {plural(dataset.columns.length, 'colonne')} ({plural(nNum, 'numérique')}, {plural(nDates, 'date')}) · {dataset.format}, {fmtBytes(dataset.sizeBytes)}
                {dataset.sheets.length > 1 && !demo && (
                  <> · feuille{' '}
                    <select className="inline-select" value={dataset.sheet ?? ''} onChange={(e) => changeSheet(e.target.value)} aria-label="Feuille Excel">
                      {dataset.sheets.map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </>
                )}
              </p>
              <dl className="ds-metrics">
                <div><dt>Complétude</dt><dd>{fmtPct(q.completeness)}</dd></div>
                <div><dt>Doublons</dt><dd className={q.duplicateRows ? 'warn' : undefined}>{fmtInt(q.duplicateRows)}</dd></div>
                <div><dt>Qualité</dt><dd className={q.score >= 75 ? 'good' : q.score >= 55 ? 'warn' : 'bad'}>{q.score}<small>/100</small></dd></div>
              </dl>
              {!engineStatus.ok && <span className="dot warn" title={engineStatus.text} />}
              {!demo && <button type="button" className="icon-btn ds-delete" onClick={deleteDataset} title="Supprimer ce jeu de données" aria-label="Supprimer ce jeu de données"><Trash2 size={15} /></button>}
            </header>

            <div className="tabs">
              <div className="tab-list" role="tablist">
                {TABS.map(([k, label]) => (
                  <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                    {label}{k === 'dashboard' && pins.length > 0 && <span className="tab-count">{pins.length}</span>}
                  </button>
                ))}
              </div>
              <div className="tabs-aside">
                {dataset.cleanedFrom && (
                  <p className="cleaned-from">Version nettoyée de{' '}
                    {datasets?.some((d) => d.id === dataset.cleanedFrom)
                      ? <button type="button" className="link-btn" onClick={() => setActiveId(dataset.cleanedFrom!)}>« {datasets.find((d) => d.id === dataset.cleanedFrom)!.name} »</button>
                      : 'un jeu supprimé'}
                  </p>
                )}
                {!demo && <LinkBar dataset={dataset} links={links} onAdd={() => setShowLink(true)} onRemove={removeLink} />}
                {tab === 'assistant' && (
                  <ExportButton disabled={!conversation?.turns.length || busy} onClick={() => exportThread(conversation?.title ?? 'Analyse', dataset.name)} />
                )}
              </div>
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

      {showLink && dataset && !demo && (
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
    </DemoContext.Provider>
  )
}
