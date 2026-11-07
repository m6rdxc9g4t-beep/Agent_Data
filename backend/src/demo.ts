// Démo publique (DATAMIND_DEMO=1) : garde-fous propres à une instance ouverte à tous.
//
//   - écritures : liste blanche des routes autorisées (tout le reste est refusé avant même la lecture du corps) ;
//   - isolement : chaque visiteur a une session éphémère en mémoire (cookie aléatoire), qui porte ses analyses ;
//     rien n'est écrit sur le disque, tout disparaît après DEMO_LIMITS.sessionTtlMs d'inactivité ou au redémarrage ;
//   - IA : limite de questions par adresse IP et par heure, une seule question à la fois sur toute l'instance
//     (petite file d'attente), étapes, délai et longueur des réponses bornés.
import { randomBytes, randomUUID } from 'node:crypto'

import type { FastifyReply, FastifyRequest } from 'fastify'

import type { Conversation } from './store.js'

export const DEMO_LIMITS = {
  /** Allers-retours modèle ↔ outils par question (12 en privé). */
  maxSteps: 6,
  /** Durée maximale d'une question, file d'attente non comprise (10 min par appel en privé). */
  turnTimeoutMs: 180_000,
  /** Délai d'un appel à Ollama. */
  callTimeoutMs: 120_000,
  /** Jetons produits par Ollama à chaque appel (`num_predict`). */
  maxOutputTokens: 1_500,
  /** Longueur maximale du texte d'une réponse (caractères). */
  maxAnswerChars: 12_000,
  /** Durée maximale d'une requête SQL (60 s en privé). */
  queryTimeoutMs: 20_000,
  /** Questions en attente derrière celle en cours, sur toute l'instance. */
  queueSize: 2,
  /** Attente maximale dans la file avant le message « occupée ». */
  queueWaitMs: 150_000,
  /** Session d'un visiteur : durée de vie sans activité, nombre de sessions gardées. */
  sessionTtlMs: 2 * 60 * 60 * 1000,
  maxSessions: 500,
  /** Analyses par session (les plus anciennes sont oubliées), questions par analyse. */
  maxConversations: 10,
  maxTurns: 12,
  /** Calculs sans IA (entraînement, prévision, requête SQL) par adresse IP et par heure. */
  computePerHour: 120,
}

export const DEMO_REFUSED = 'Indisponible dans la démo publique : seuls les jeux d’exemple sont proposés, en lecture seule.'
export const DEMO_BUSY = 'La démo est occupée, réessaie dans un instant.'
export const DEMO_CLAUDE_OFF = 'Claude est désactivé dans la démo publique : seule l’IA du serveur (Ollama) répond.'
export const DEMO_TIMEOUT = 'Délai de la démo dépassé (3 min) : une question plus courte ou plus simple a plus de chances d’aboutir.'

/**
 * Routes autres que GET autorisées en démo (méthode + motif de route Fastify). Aucune n'écrit sur le disque :
 * lecture SQL, calculs en mémoire, ouverture d'un jeu d'exemple déjà chargé, analyses de la session du visiteur.
 */
export const DEMO_WRITE_ALLOWED = new Set([
  'POST /api/samples/:file',
  'POST /api/datasets/:id/query',
  'POST /api/datasets/:id/ml/train',
  'POST /api/datasets/:id/ml/forecast',
  'POST /api/ml/models/:id/predict',
  'POST /api/datasets/:id/conversations',
  'PATCH /api/conversations/:id',
  'DELETE /api/conversations/:id',
  'POST /api/conversations/:id/messages',
])

/** Lectures liées à des fonctions absentes de la démo (fichiers liés, modèles enregistrés). */
export const DEMO_READ_BLOCKED = new Set([
  'GET /api/datasets/:id/links/suggest',
  'GET /api/ml/models/:id/score',
  'GET /api/ml/models/:id/score.csv',
])

/** Routes de calcul soumises à la limite `computePerHour`. */
export const DEMO_COMPUTE = new Set([
  'POST /api/datasets/:id/query',
  'POST /api/datasets/:id/ml/train',
  'POST /api/datasets/:id/ml/forecast',
])

// ── Adresse du visiteur ────────────────────────────────────────────────────────────────────────

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Adresse IP réelle du visiteur. `X-Forwarded-For` n'est lu que si la connexion vient du proxy de bouclage
 * (127.0.0.1) ; on prend alors la dernière adresse de la liste, celle qu'a ajoutée notre proxy
 * (les précédentes peuvent être inventées par le client). Sinon : l'adresse de la connexion.
 */
export function clientIp(req: FastifyRequest): string {
  const remote = req.socket.remoteAddress ?? ''
  if (!LOOPBACK.has(remote)) return remote || 'inconnue'
  const header = req.headers['x-forwarded-for']
  const raw = Array.isArray(header) ? header.join(',') : header ?? ''
  const last = raw.split(',').map((s) => s.trim()).filter(Boolean).at(-1)
  return last && /^[0-9a-fA-F:.]{2,45}$/.test(last) ? last : remote
}

/** La requête est-elle arrivée en HTTPS (dit par le proxy de bouclage) ? */
function viaHttps(req: FastifyRequest): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
}

// ── Limite par fenêtre glissante d'une heure ──────────────────────────────────────────────────

export class HourlyLimit {
  private hits = new Map<string, number[]>()
  constructor(readonly perHour: number, private readonly now: () => number = Date.now) {}

  private recent(key: string): number[] {
    const since = this.now() - 3_600_000
    const list = (this.hits.get(key) ?? []).filter((t) => t > since)
    if (list.length) this.hits.set(key, list)
    else this.hits.delete(key)
    return list
  }

  /** Minutes avant qu'une nouvelle demande soit acceptée (0 : acceptée maintenant). */
  waitMinutes(key: string): number {
    const list = this.recent(key)
    if (list.length < this.perHour) return 0
    return Math.max(1, Math.ceil((list[0] + 3_600_000 - this.now()) / 60_000))
  }

  /** Rend la dernière demande (question qui n'a finalement pas été traitée). */
  refund(key: string): void {
    const list = this.hits.get(key)
    if (list?.length) list.pop()
  }

  take(key: string): void {
    const list = this.recent(key)
    list.push(this.now())
    this.hits.set(key, list)
    if (this.hits.size > 20_000) {
      for (const k of [...this.hits.keys()].slice(0, 5_000)) this.recent(k)
      if (this.hits.size > 20_000) this.hits.delete(this.hits.keys().next().value as string)
    }
  }
}

// ── Une question à la fois sur toute l'instance ───────────────────────────────────────────────

export class DemoBusyError extends Error {
  constructor() { super(DEMO_BUSY) }
}

/** Place unique pour l'IA, avec une file d'attente courte. `release` libère la place (une seule fois). */
export class SingleSlot {
  private running = false
  private waiting: { grant: () => void }[] = []
  constructor(readonly queueSize: number, readonly maxWaitMs: number) {}

  get busy(): boolean { return this.running }
  get queued(): number { return this.waiting.length }

  /**
   * Demande la place. `null` : file pleine. Sinon `queued` dit s'il faut attendre et `ready` donne la fonction
   * qui libère la place (rejetée par `DemoBusyError` si l'attente dépasse `maxWaitMs` ou si le visiteur part).
   */
  enter(signal?: AbortSignal): { queued: boolean; ready: Promise<() => void> } | null {
    if (!this.running) {
      this.running = true
      return { queued: false, ready: Promise.resolve(this.releaser()) }
    }
    if (this.waiting.length >= this.queueSize) return null
    const ready = new Promise<() => void>((resolve, reject) => {
      const leave = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiting = this.waiting.filter((w) => w !== entry)
      }
      const entry = { grant: () => { leave(); resolve(this.releaser()) } }
      const onAbort = () => { leave(); reject(new DemoBusyError()) }
      const timer = setTimeout(onAbort, this.maxWaitMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(entry)
    })
    return { queued: true, ready }
  }

  private releaser(): () => void {
    let done = false
    return () => {
      if (done) return
      done = true
      const next = this.waiting[0]
      if (next) next.grant() // la place passe directement au suivant
      else this.running = false
    }
  }
}

// ── Sessions éphémères des visiteurs ──────────────────────────────────────────────────────────

const COOKIE = 'datamind_demo'

export interface DemoSession {
  id: string
  lastSeen: number
  /** Jeux d'exemple ouverts par ce visiteur (liste de la barre latérale). */
  opened: Map<string, number>
  conversations: Map<string, Conversation>
}

/** Sessions en mémoire, identifiées par un cookie aléatoire (256 bits), oubliées après inactivité. */
export class DemoSessions {
  private sessions = new Map<string, DemoSession>()
  constructor(private readonly now: () => number = Date.now) {}

  get size(): number { return this.sessions.size }

  private prune() {
    const limit = this.now() - DEMO_LIMITS.sessionTtlMs
    for (const [id, s] of this.sessions) if (s.lastSeen < limit) this.sessions.delete(id)
  }

  /** Session du visiteur, ou `null` sans cookie valide (ne crée rien). */
  find(req: FastifyRequest): DemoSession | null {
    const id = readCookie(req.headers.cookie, COOKIE)
    if (!id) return null
    const s = this.sessions.get(id)
    if (!s || s.lastSeen < this.now() - DEMO_LIMITS.sessionTtlMs) {
      if (s) this.sessions.delete(id)
      return null
    }
    s.lastSeen = this.now()
    this.sessions.delete(id) // réinsertion : l'ordre de la Map suit l'activité (la plus ancienne en tête)
    this.sessions.set(id, s)
    return s
  }

  /** Session du visiteur, créée au besoin (et posée en cookie). */
  get(req: FastifyRequest, reply: FastifyReply): DemoSession {
    const found = this.find(req)
    if (found) return found
    this.prune()
    while (this.sessions.size >= DEMO_LIMITS.maxSessions) this.sessions.delete(this.sessions.keys().next().value as string)
    const s: DemoSession = { id: randomBytes(32).toString('base64url'), lastSeen: this.now(), opened: new Map(), conversations: new Map() }
    this.sessions.set(s.id, s)
    const secure = viaHttps(req) ? '; Secure' : ''
    reply.header('set-cookie', `${COOKIE}=${s.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEMO_LIMITS.sessionTtlMs / 1000}${secure}`)
    return s
  }

  createConversation(s: DemoSession, datasetId: string): Conversation {
    const now = new Date().toISOString()
    const conv: Conversation = { id: randomUUID(), datasetId, title: 'Nouvelle analyse', createdAt: now, updatedAt: now, turns: [] }
    s.conversations.set(conv.id, conv)
    while (s.conversations.size > DEMO_LIMITS.maxConversations) s.conversations.delete(s.conversations.keys().next().value as string)
    return conv
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) {
      const value = v.join('=')
      return /^[\w-]{43}$/.test(value) ? value : null
    }
  }
  return null
}
