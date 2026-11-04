// Outils de l'agent : définitions (schémas JSON) et exécution sur la base du jeu de données.
import { forecast, kmeans, predictiveModel } from '../analysis.js'
import { buildChart, CHART_TYPES } from '../charts.js'
import { QueryError, type DatasetDb } from '../db.js'
import type { Profile } from '../profile.js'
import type { ToolOutput } from '../store.js'

export interface ToolDef {
  name: string
  description: string
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[] }
}

export const TOOLS: ToolDef[] = [
  {
    name: 'run_sql',
    description: 'Exécute une requête SQL DuckDB en lecture seule sur la table `data` et renvoie le résultat (50 lignes au plus pour toi). ' +
      'Utilise-la pour tout calcul : comptages, agrégats, statistiques, corrélations, filtres.',
    input_schema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'Une seule requête SELECT / WITH / SUMMARIZE sur la table data.' } },
      required: ['sql'],
    },
  },
  {
    name: 'create_chart',
    description: "Crée un graphique affiché à l'utilisateur, à partir d'une requête SQL. x = colonne des catégories ou du temps, " +
      'y = colonne(s) de valeurs. histogram : la requête renvoie une colonne numérique brute (x). heatmap : colonnes x, series et y (valeur). ' +
      'series (facultatif) : colonne qui sépare plusieurs courbes ou barres.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...CHART_TYPES] },
        title: { type: 'string', description: 'Titre explicite du graphique.' },
        sql: { type: 'string', description: 'Requête SQL qui produit les données du graphique.' },
        x: { type: 'string', description: 'Nom de la colonne en abscisse (ou des catégories).' },
        y: { type: 'array', items: { type: 'string' }, description: 'Nom(s) de colonne(s) de valeurs.' },
        series: { type: 'string', description: 'Colonne de regroupement (facultatif).' },
        subtitle: { type: 'string' },
      },
      required: ['type', 'title', 'sql', 'x'],
    },
  },
  {
    name: 'segment',
    description: 'Segmentation k-means sur des colonnes numériques (normalisées). Sans k, le nombre de segments est choisi par le score silhouette.',
    input_schema: {
      type: 'object',
      properties: {
        columns: { type: 'array', items: { type: 'string' }, description: 'Colonnes numériques (toutes par défaut).' },
        k: { type: 'integer', minimum: 2, maximum: 10 },
      },
      required: [],
    },
  },
  {
    name: 'predict',
    description: 'Entraîne et évalue (découpe 80/20) un modèle prédictif : régression linéaire si la cible est numérique, logistique si elle est binaire. ' +
      "Renvoie les métriques, la comparaison à une baseline et les facteurs d'influence.",
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Colonne à prédire.' },
        features: { type: 'array', items: { type: 'string' }, description: 'Variables explicatives (toutes les utilisables par défaut).' },
      },
      required: ['target'],
    },
  },
  {
    name: 'forecast',
    description: 'Prévision temporelle (tendance linéaire + saisonnalité) d\'un indicateur agrégé par période, avec graphique.',
    input_schema: {
      type: 'object',
      properties: {
        date_column: { type: 'string' },
        value_column: { type: 'string' },
        agg: { type: 'string', enum: ['sum', 'avg', 'count', 'median', 'max', 'min'] },
        grain: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'] },
        periods: { type: 'integer', minimum: 1, maximum: 24 },
      },
      required: ['date_column', 'value_column'],
    },
  },
]

export const TOOL_LABELS: Record<string, string> = {
  run_sql: 'Requête SQL',
  create_chart: 'Graphique',
  segment: 'Segmentation',
  predict: 'Modèle prédictif',
  forecast: 'Prévision',
}

function textTable(columns: { name: string }[], rows: unknown[][], max = 50): string {
  const fmt = (v: unknown) => (v === null || v === undefined ? '∅' : typeof v === 'number' ? String(Number(v.toPrecision(8))) : String(v).slice(0, 60))
  const lines = [columns.map((c) => c.name).join(' | '), ...rows.slice(0, max).map((r) => r.map(fmt).join(' | '))]
  if (rows.length > max) lines.push(`… ${rows.length - max} ligne(s) de plus`)
  return lines.join('\n')
}

const asList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()) : undefined

export interface ToolContext {
  db: DatasetDb
  profile: Profile
}

export async function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  try {
    switch (name) {
      case 'run_sql': {
        const sql = String(input.sql ?? input.query ?? '')
        const r = await ctx.db.safeQuery(sql, 200)
        const more = r.truncated ? ' (résultat tronqué)' : ''
        return {
          ok: true, sql, table: r,
          summary: `${r.rows.length} ligne(s)${more}\n${textTable(r.columns, r.rows)}`,
        }
      }
      case 'create_chart': {
        const chart = await buildChart(ctx.db, {
          type: String(input.type ?? 'bar'), title: String(input.title ?? ''), sql: String(input.sql ?? ''),
          x: String(input.x ?? ''), y: asList(input.y), series: input.series ? String(input.series) : undefined,
          subtitle: input.subtitle ? String(input.subtitle) : undefined,
        })
        const cols = chart.data.columns.map((c) => ({ name: c }))
        return {
          ok: true, sql: String(input.sql), chart,
          summary: `Graphique « ${chart.title} » affiché (${chart.data.rows.length} point(s)). Données :\n${textTable(cols, chart.data.rows, 25)}`,
        }
      }
      case 'segment': {
        const r = await kmeans(ctx.db, ctx.profile, asList(input.columns), input.k ? Number(input.k) : undefined)
        return { ok: true, table: r.table, summary: `${r.summary}\n${textTable(r.table.columns, r.table.rows)}` }
      }
      case 'predict': {
        const r = await predictiveModel(ctx.db, ctx.profile, String(input.target ?? ''), asList(input.features))
        return { ok: true, table: r.table, chart: r.chart, summary: `${r.summary}\n${textTable(r.table.columns, r.table.rows)}` }
      }
      case 'forecast': {
        const r = await forecast(ctx.db, ctx.profile, String(input.date_column ?? ''), String(input.value_column ?? ''), {
          agg: input.agg ? String(input.agg) : undefined, grain: input.grain ? String(input.grain) : undefined,
          periods: input.periods ? Number(input.periods) : undefined,
        })
        return { ok: true, table: r.table, chart: r.chart, summary: `${r.summary}\n${textTable(r.table.columns, r.table.rows)}` }
      }
      default:
        return { ok: false, summary: `Outil inconnu : ${name}. Outils disponibles : ${TOOLS.map((t) => t.name).join(', ')}.`, error: 'Outil inconnu' }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message, sql: typeof input.sql === 'string' ? input.sql : undefined, summary: `Erreur : ${message}` }
  }
}

export { QueryError }
