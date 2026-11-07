// Types partagés avec l'API (voir backend/src/store.ts et profile.ts).

export interface Column { name: string; type: string }

export interface DatasetMeta {
  id: string
  name: string
  fileName: string
  format: string
  rows: number
  columns: Column[]
  sizeBytes: number
  createdAt: string
  sheets: string[]
  sheet: string | null
  sample: boolean
  lastActivityAt?: string
  links?: DatasetLink[]
  cleanedFrom?: string
  descriptions?: Record<string, string>
  context?: string
}

export interface DatasetLink { id: string; table: string }
export interface LinkInfo extends DatasetLink { name: string; rows: number; columns: Column[]; keys: { column: string; other: string }[] }
export interface LinkSuggestion {
  table: string
  keys: { column: string; other: string; matchShare: number; uniqueInOther: boolean; distinct: number }[]
}

export type Kind = 'numeric' | 'datetime' | 'boolean' | 'category' | 'text' | 'id' | 'constant'

export interface ColumnProfile {
  name: string
  type: string
  kind: Kind
  missing: number
  completeness: number
  distinct: number
  min: string | number | null
  max: string | number | null
  mean: number | null
  median: number | null
  std: number | null
  top: string | null
  topCount: number | null
}

export interface Quality {
  score: number
  grade: string
  completeness: number
  duplicateRows: number
  constantColumns: string[]
  highMissing: { column: string; share: number }[]
  outliers: { column: string; share: number }[]
  numericAsText: string[]
  recommendations: string[]
}

export interface DatasetDetail extends DatasetMeta {
  profile: { rows: number; columns: ColumnProfile[]; quality: Quality }
}

export interface ChartSpec {
  type: 'bar' | 'horizontal_bar' | 'line' | 'area' | 'scatter' | 'pie' | 'histogram' | 'heatmap'
  title: string
  subtitle?: string
  x: string
  y: string[]
  series?: string
  data: { columns: string[]; rows: unknown[][] }
  stacked?: boolean
  xLabel?: string
  yLabel?: string
  diagonal?: boolean
}

export interface TableData { columns: Column[]; rows: unknown[][]; truncated: boolean }

export interface ToolOutput {
  ok: boolean
  summary: string
  error?: string
  table?: TableData
  chart?: ChartSpec
  sql?: string
}

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; result?: ToolOutput }

export interface Turn {
  id: string
  question: string
  label?: string
  blocks: Block[]
  engine: string
  model: string
  createdAt: string
  durationMs?: number
  usage?: { inputTokens: number; outputTokens: number }
  error?: string
  pending?: boolean
  /** Démo : la question attend son tour (une seule à la fois sur l'instance). */
  queued?: string
}

export interface ConversationSummary {
  id: string
  datasetId: string
  title: string
  createdAt: string
  updatedAt: string
  turnCount?: number
}

export interface Conversation extends ConversationSummary { turns: Turn[] }

export interface QuickAnalysis { key: string; group: string; label: string; icon: string; summary: string; prompt: string }

export interface AppConfig {
  version: string
  instanceLabel: string
  defaultEngine: 'ollama' | 'claude'
  maxUploadMb: number
  formats: string[]
  ollama: { reachable: boolean; error: string | null; models: string[]; model: string }
  claude: { plan: boolean; serverKey: boolean; model: string; models: { id: string; label: string }[] }
  /** Démo publique (DATAMIND_DEMO=1) : jeux d'exemple seulement, Ollama seul ; `null` sur une instance privée. */
  demo: { questionsPerHour: number; returnUrl: string | null } | null
  quickAnalyses: QuickAnalysis[]
  featured: string[]
  toolLabels: Record<string, string>
}

export interface Sample {
  file: string
  label: string
  domain: string
  rows: number
  columns: number
  description: string
  ideas: string[]
  datasetId: string | null
}

export interface EngineChoice { engine: 'ollama' | 'claude'; ollamaModel: string; claudeModel: string; apiKey: string }

// ── Prédiction ────────────────────────────────────────────────────────────────────────────────
export type Task = 'regression' | 'binary' | 'multiclass'

export interface MlOptions {
  targets: { name: string; kind: Kind; task: Task }[]
  features: { name: string; kind: Kind; usable: boolean }[]
  dates: string[]
  values: string[]
}

export interface Metric { key: string; label: string; value: number; higherIsBetter: boolean }

export interface TrainResult {
  id: string
  target: { name: string; task: Task; classes: string[] }
  task: Task
  rows: { train: number; validation: number; test: number }
  features: string[]
  models: { kind: string; label: string; hint: string; metrics: Metric[]; score: number; trainMs: number; detail: string }[]
  best: string
  importance: ChartSpec
  quality: ChartSpec
  simulator: { name: string; kind: 'num' | 'cat' | 'date'; levels?: string[]; default: string | number }[]
  summary: string
  durationMs: number
}

export interface ForecastResult {
  date: string
  value: string
  agg: string
  grain: string
  periods: number
  history: number
  models: { kind: string; label: string; hint: string; mae: number; mape: number | null; detail: string }[]
  best: string
  chart: ChartSpec
  table: TableData
  summary: string
}

export interface Pin {
  id: string
  key: string
  kind: 'chart' | 'table' | 'text'
  title: string
  note?: string
  wide?: boolean
  chart?: ChartSpec
  table?: TableData
  text?: string
  sql?: string
  source: string
  createdAt: string
}

export type NewPin = Omit<Pin, 'id' | 'createdAt'>

export type CleanStepKind = 'dedupe' | 'trim' | 'convert' | 'drop_columns' | 'fill_missing' | 'cap_outliers'
export interface PlannedStep { kind: CleanStepKind; columns: string[]; title: string; detail: string; recommended: boolean; columnNotes: Record<string, string> }

export interface SavedModel {
  id: string
  name: string
  datasetId: string
  datasetName: string
  target: { name: string; task: Task; classes: string[] }
  label: string
  metrics: Metric[]
  summary: string
  features: string[]
  simulator: TrainResult['simulator']
  rows: number
  createdAt: string
}

export interface ScorePreview {
  dataset: { id: string; name: string }
  total: number
  truncated: boolean
  missing: string[]
  task: Task
  target: string
  distribution: { value: string; rows: number }[] | null
  stats: { mean: number; min: number; max: number } | null
  preview: TableData
  columns: number
}
