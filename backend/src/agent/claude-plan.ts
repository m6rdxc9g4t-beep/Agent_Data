// Moteur « Claude avec ton forfait » : Claude Agent SDK authentifié par l'abonnement Claude (Pro / Max),
// sans clé API. Le jeton vient de `claude setup-token` (variable CLAUDE_CODE_OAUTH_TOKEN).
// Usage personnel : il consomme les limites de l'abonnement de la personne qui a créé le jeton.
//
// Les outils de DataMind sont exposés au modèle par un serveur MCP en mémoire ; tous les outils intégrés
// de Claude Code (fichiers, commandes, web) sont désactivés : l'agent ne peut que lire les données via nos outils.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createSdkMcpServer, query, tool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import { config } from '../config.js'
import { EngineError, STEP_LIMIT, type RunOptions, type Usage } from './engines.js'
import { runTool } from './tools.js'

const SERVER = 'datamind'

export function buildServer(opts: RunOptions) {
  let seq = 0
  const run = async (name: string, input: Record<string, unknown>) => {
    const id = `p${Date.now().toString(36)}${(seq++).toString(36)}`
    opts.onEvent({ type: 'tool_start', id, name, input })
    const out = await runTool(name, input, opts.ctx)
    opts.onEvent({ type: 'tool_end', id, result: out })
    return { content: [{ type: 'text' as const, text: out.summary }], isError: !out.ok }
  }
  const chartTypes = ['bar', 'horizontal_bar', 'line', 'area', 'scatter', 'pie', 'histogram', 'heatmap'] as const
  return createSdkMcpServer({
    name: SERVER,
    version: config.version,
    tools: [
      tool('run_sql', 'Exécute une requête SQL DuckDB en lecture seule sur la table `data` et renvoie le résultat (50 lignes au plus).',
        { sql: z.string().describe('Une seule requête SELECT / WITH / SUMMARIZE sur la table data.') },
        (a) => run('run_sql', a)),
      tool('create_chart', "Crée un graphique affiché à l'utilisateur à partir d'une requête SQL. x = catégories ou temps, y = colonne(s) de valeurs. " +
        'histogram : la requête renvoie une colonne numérique brute (x). heatmap : colonnes x, series et y (valeur).',
        {
          type: z.enum(chartTypes), title: z.string(), sql: z.string(), x: z.string(),
          y: z.array(z.string()).optional(), series: z.string().optional(), subtitle: z.string().optional(),
        },
        (a) => run('create_chart', a)),
      tool('segment', 'Segmentation k-means sur des colonnes numériques normalisées ; sans k, choisi par le score silhouette.',
        { columns: z.array(z.string()).optional(), k: z.number().int().min(2).max(10).optional() },
        (a) => run('segment', a)),
      tool('predict', 'Entraîne et évalue (80/20) un modèle prédictif : régression linéaire (cible numérique) ou logistique (cible binaire).',
        { target: z.string(), features: z.array(z.string()).optional() },
        (a) => run('predict', a)),
      tool('forecast', "Prévision temporelle (tendance + saisonnalité) d'un indicateur agrégé par période, avec graphique.",
        {
          date_column: z.string(), value_column: z.string(),
          agg: z.enum(['sum', 'avg', 'count', 'median', 'max', 'min']).optional(),
          grain: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
          periods: z.number().int().min(1).max(24).optional(),
        },
        (a) => run('forecast', a)),
    ],
  })
}

/** Historique et question en un seul message (le SDK ne reçoit pas d'historique structuré). */
function promptText(opts: RunOptions): string {
  if (!opts.history.length) return opts.question
  const past = opts.history.map((h) => `${h.role === 'user' ? 'Question précédente' : 'Ta réponse'} :\n${h.content}`).join('\n\n')
  return `Échanges précédents de cette analyse :\n\n${past}\n\n---\nNouvelle question :\n${opts.question}`
}

export async function runClaudePlan(opts: RunOptions, model: string): Promise<Usage> {
  const token = config.claudeOauthToken
  if (!token) throw new EngineError('Forfait Claude non configuré : renseignez CLAUDE_CODE_OAUTH_TOKEN (claude setup-token).')

  // Dossier de travail et configuration de Claude Code isolés, dans DATA_DIR.
  const home = join(config.dataDir, 'claude')
  await mkdir(home, { recursive: true })

  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _auth, ...inherited } = process.env
  const abortController = new AbortController()
  opts.signal?.addEventListener('abort', () => abortController.abort(), { once: true })

  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: promptText(opts) }, parent_tool_use_id: null } as SDKUserMessage
  }

  const allowed = ['run_sql', 'create_chart', 'segment', 'predict', 'forecast'].map((t) => `mcp__${SERVER}__${t}`)
  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  const stderr: string[] = []
  const q = query({
    prompt: input(),
    options: {
      model,
      systemPrompt: opts.system,
      mcpServers: { [SERVER]: buildServer(opts) },
      tools: [],
      canUseTool: async (name) => (allowed.includes(name)
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Seuls les outils de DataMind sont disponibles.' }),
      maxTurns: (opts.maxSteps ?? config.maxSteps) + 1,
      settingSources: [],
      persistSession: false,
      cwd: home,
      abortController,
      env: { ...inherited, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_CODE_OAUTH_TOKEN: token,
        CLAUDE_AGENT_SDK_CLIENT_APP: `datamind/${config.version}`, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' },
      stderr: (d) => { stderr.push(d); if (stderr.length > 50) stderr.shift() },
    },
  })

  try {
    for await (const msg of q) {
      if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
        if (msg.error) {
          // Message d'erreur synthétique (authentification, limite…) : on l'explique au lieu de l'afficher tel quel.
          const text = msg.message.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ')
          throw new EngineError(msg.error === 'authentication_failed'
            ? 'Jeton du forfait Claude refusé : régénérez-le avec « claude setup-token ».' : explain(`${msg.error} ${text}`))
        }
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.trim()) opts.onEvent({ type: 'text', text: block.text })
        }
      } else if (msg.type === 'result') {
        const u = msg.usage as unknown as Record<string, number | undefined>
        usage.inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        usage.outputTokens = u.output_tokens ?? 0
        if (msg.subtype === 'error_max_turns') opts.onEvent({ type: 'text', text: STEP_LIMIT })
        else if (msg.is_error) {
          const detail = msg.subtype === 'success' ? msg.result : (msg as { errors?: string[] }).errors?.join(' ')
          throw new EngineError(explain(detail || stderr.join('').slice(-300)))
        }
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) throw err
    if (err instanceof EngineError) throw err
    throw new EngineError(explain(err instanceof Error ? err.message : String(err)))
  } finally {
    q.close()
  }
  return usage
}

function explain(detail: string): string {
  if (/401|authenticat|invalid.*(token|bearer)|oauth/i.test(detail)) {
    return 'Jeton du forfait Claude refusé : régénérez-le avec « claude setup-token » puis mettez à jour CLAUDE_CODE_OAUTH_TOKEN.'
  }
  if (/rate.?limit|usage limit|429|quota|credit/i.test(detail)) {
    return 'Limite d’utilisation de votre forfait Claude atteinte : réessayez plus tard ou passez sur Ollama.'
  }
  return `Claude (forfait) : ${detail.trim().slice(0, 300) || 'erreur inconnue'}`
}
