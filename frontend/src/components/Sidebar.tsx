// Barre latérale : jeux de données, analyses du jeu ouvert, moteur IA et thème.
import { useRef, useState } from 'react'
import { Cpu, KeyRound, LibraryBig, Monitor, Moon, Plus, RefreshCw, Search, Sun, Trash2, Upload, X } from 'lucide-react'

import { fmtInt, fmtRelative } from '../format'
import { useDemo } from '../demo'
import { Brand } from './Brand'
import { useTheme, type ThemeMode } from '../theme'
import type { AppConfig, ConversationSummary, DatasetMeta, EngineChoice } from '../types'

interface Props {
  config: AppConfig | null
  datasets: DatasetMeta[]
  activeId: string | null
  conversations: ConversationSummary[]
  activeConversation: string | null
  engine: EngineChoice
  engineStatus: { ok: boolean; text: string }
  uploading: number | null
  onUpload: (f: File) => void
  onOpenSamples: () => void
  onSelectDataset: (id: string) => void
  onSelectConversation: (id: string) => void
  onNewConversation: () => void
  onDeleteConversation: (id: string) => void
  onEngine: (e: EngineChoice) => void
  onRefreshConfig: () => void
  /** Petits écrans : la barre latérale est un tiroir. */
  open: boolean
  onClose: () => void
}

export function Sidebar(p: Props) {
  const file = useRef<HTMLInputElement>(null)
  const { mode, setMode } = useTheme()
  const [showKey, setShowKey] = useState(false)
  const [filter, setFilter] = useState('')
  const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const shown = filter.trim() ? p.datasets.filter((d) => norm(d.name).includes(norm(filter.trim()))) : p.datasets
  const searchable = p.datasets.length > 6
  const cfg = p.config
  const e = p.engine
  const demo = useDemo()

  return (
    <aside className={`sidebar${p.open ? ' open' : ''}`} aria-label="Navigation">
      <div className="brand">
        <Brand instanceLabel={cfg?.instanceLabel} version={cfg?.version} />
        <button type="button" className="icon-btn drawer-close" onClick={p.onClose} aria-label="Fermer le menu"><X size={18} /></button>
      </div>

      {!demo && (
        <button type="button" className="import-btn" onClick={() => file.current?.click()} disabled={p.uploading !== null}>
          {p.uploading !== null ? <><span className="progress" style={{ width: `${p.uploading * 100}%` }} /> Import en cours… {Math.round(p.uploading * 100)} %</>
            : <><Upload size={16} /> Importer un fichier</>}
        </button>
      )}
      <button type="button" className="samples-btn" onClick={p.onOpenSamples}><LibraryBig size={16} /> Jeux d’exemple</button>
      {!demo && <input ref={file} type="file" hidden accept={cfg?.formats.join(',')} onChange={(ev) => { const f = ev.target.files?.[0]; if (f) p.onUpload(f); ev.target.value = '' }} />}

      <nav className="nav" aria-label="Jeux de données">
        <h3>Jeux de données{p.datasets.length > 1 && <span className="count">{p.datasets.length}</span>}</h3>
        {searchable && (
          <label className="nav-search">
            <Search size={14} aria-hidden />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Rechercher un jeu…" aria-label="Rechercher un jeu de données" />
            {filter && <button type="button" onClick={() => setFilter('')} aria-label="Effacer la recherche"><X size={13} /></button>}
          </label>
        )}
        {p.datasets.length === 0 && <p className="nav-empty">{demo ? 'Ouvrez un jeu d’exemple pour commencer.' : 'Aucun pour l’instant.'}</p>}
        {p.datasets.length > 0 && shown.length === 0 && <p className="nav-empty">Aucun jeu ne contient « {filter.trim()} ».</p>}
        <ul>
          {shown.map((d) => (
            <li key={d.id}>
              <button type="button" className={`nav-item${d.id === p.activeId ? ' active' : ''}`} onClick={() => p.onSelectDataset(d.id)} aria-current={d.id === p.activeId}>
                <span className="fmt">{d.format.slice(0, 4)}</span>
                <span className="nav-text"><span className="nav-title">{d.name}</span><span className="nav-sub">{fmtInt(d.rows)} lignes, {d.columns.length} col. · {fmtRelative(d.lastActivityAt ?? d.createdAt)}</span></span>
              </button>
              {d.id === p.activeId && (
                <ul className="convs">
                  <li>
                    <button type="button" className="conv new" onClick={p.onNewConversation}><Plus size={14} /> Nouvelle analyse</button>
                  </li>
                  {p.conversations.map((c) => (
                    <li key={c.id} className="conv-row">
                      <button type="button" className={`conv${c.id === p.activeConversation ? ' active' : ''}`} onClick={() => p.onSelectConversation(c.id)}>
                        <span className="conv-title">{c.title}</span>
                        <span className="conv-date">{fmtRelative(c.updatedAt)}</span>
                      </button>
                      <button type="button" className="conv-del" onClick={() => p.onDeleteConversation(c.id)} aria-label={`Supprimer « ${c.title} »`}><Trash2 size={13} /></button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </nav>

      <div className="engine">
        <div className="engine-head">
          <h3>Moteur IA</h3>
          {!p.engineStatus.ok && <span className="dot warn" title={p.engineStatus.text} />}
          <button type="button" className="icon-btn small" onClick={p.onRefreshConfig} title="Vérifier à nouveau"><RefreshCw size={13} /></button>
        </div>
        {demo && <p className="engine-msg"><Cpu size={13} aria-hidden /> IA du serveur{cfg?.ollama.reachable && cfg.ollama.model ? ` · ${cfg.ollama.model}` : ''}</p>}
        {!demo && <div className="segmented" role="radiogroup" aria-label="Moteur IA">
          {(['ollama', 'claude'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={e.engine === k} className={e.engine === k ? 'on' : ''} onClick={() => p.onEngine({ ...e, engine: k })}>
              {k === 'ollama' ? <><Cpu size={14} /> Ollama</> : <>Claude</>}
            </button>
          ))}
        </div>}
        {cfg && !demo && e.engine === 'ollama' && (
          cfg.ollama.models.length
            ? <select value={e.ollamaModel} onChange={(ev) => p.onEngine({ ...e, ollamaModel: ev.target.value })} aria-label="Modèle Ollama">
                {cfg.ollama.models.map((m) => <option key={m}>{m}</option>)}
              </select>
            : null
        )}
        {cfg && !demo && e.engine === 'claude' && (
          <>
            <select value={e.claudeModel} onChange={(ev) => p.onEngine({ ...e, claudeModel: ev.target.value })} aria-label="Modèle Claude">
              {cfg.claude.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            {cfg.claude.plan && <p className="engine-msg">Utilise ton abonnement Claude, sans clé API.</p>}
            {!cfg.claude.plan && !cfg.claude.serverKey && (
              showKey || !e.apiKey
                ? <label className="key">
                    <KeyRound size={14} aria-hidden />
                    <input type="password" placeholder="Clé API Anthropic (sk-ant-…)" value={e.apiKey} autoComplete="off"
                      onChange={(ev) => p.onEngine({ ...e, apiKey: ev.target.value.trim() })} onBlur={() => setShowKey(false)} />
                  </label>
                : <button type="button" className="engine-msg link" onClick={() => setShowKey(true)}>Clé saisie pour cette session · modifier</button>
            )}
          </>
        )}
        {!p.engineStatus.ok && <p className="engine-status warn">{p.engineStatus.text}</p>}
      </div>

      <div className="side-foot">
        <div className="theme-switch" role="radiogroup" aria-label="Thème">
          {([['system', Monitor, 'Comme le système'], ['light', Sun, 'Clair'], ['dark', Moon, 'Sombre']] as const).map(([m, Icon, label]) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m as ThemeMode)} title={label} aria-label={label}>
              <Icon size={14} />
            </button>
          ))}
        </div>
        {cfg?.version && <span className="version">v{cfg.version}</span>}
      </div>
    </aside>
  )
}
