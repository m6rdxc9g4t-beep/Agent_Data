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
  claude: { serverKey: boolean; model: string; models: { id: string; label: string }[] }
  quickAnalyses: QuickAnalysis[]
  featured: string[]
  toolLabels: Record<string, string>
}

export interface Sample { file: string; label: string; hint: string }

export interface EngineChoice { engine: 'ollama' | 'claude'; ollamaModel: string; claudeModel: string; apiKey: string }
