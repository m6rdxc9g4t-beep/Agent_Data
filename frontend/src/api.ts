// Accès à l'API du backend.
import type {
  AppConfig, ChartSpec, CleanStepKind, SavedModel, ScorePreview, DatasetLink, PlannedStep, LinkInfo, LinkSuggestion, NewPin, Pin, ColumnProfile, Conversation, ConversationSummary, DatasetDetail, DatasetMeta, ForecastResult, MlOptions, Sample, TableData,
  ToolOutput, TrainResult,
} from './types'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { /* réponse non JSON */ }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error
      ?? (res.status === 401 ? 'Session expirée : reconnectez-vous au portail.' : `Erreur ${res.status}`)
    throw new ApiError(res.status, msg)
  }
  return body as T
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const api = {
  config: () => request<AppConfig>('/api/config'),
  samples: () => request<Sample[]>('/api/samples'),
  loadSample: (file: string) => request<DatasetMeta>(`/api/samples/${encodeURIComponent(file)}`, json('POST')),
  datasets: () => request<DatasetMeta[]>('/api/datasets'),
  dataset: (id: string) => request<DatasetDetail>(`/api/datasets/${id}`),
  renameDataset: (id: string, name: string) => request<DatasetMeta>(`/api/datasets/${id}`, json('PATCH', { name })),
  updateDataset: (id: string, patch: { descriptions?: Record<string, string>; context?: string }) =>
    request<DatasetMeta>(`/api/datasets/${id}`, json('PATCH', patch)),
  query: (id: string, sql: string) => request<TableData & { durationMs: number }>(`/api/datasets/${id}/query`, json('POST', { sql })),
  deleteDataset: (id: string) => request<void>(`/api/datasets/${id}`, json('DELETE')),
  selectSheet: (id: string, sheet: string) => request<DatasetMeta>(`/api/datasets/${id}/sheet`, json('POST', { sheet })),
  charts: (id: string) => request<ChartSpec[]>(`/api/datasets/${id}/charts`),
  column: (id: string, name: string) =>
    request<{ column: ColumnProfile; chart: ChartSpec | null; top: TableData }>(`/api/datasets/${id}/columns/${encodeURIComponent(name)}`),
  rows: (id: string, p: { offset: number; limit: number; q: string; sort?: string; dir?: 'asc' | 'desc' }) => {
    const qs = new URLSearchParams({ offset: String(p.offset), limit: String(p.limit), q: p.q, ...(p.sort ? { sort: p.sort, dir: p.dir ?? 'asc' } : {}) })
    return request<{ total: number; offset: number; limit: number; columns: TableData['columns']; rows: unknown[][] }>(`/api/datasets/${id}/rows?${qs}`)
  },
  exportUrl: (id: string, q = '') => `/api/datasets/${id}/export.csv${q ? `?q=${encodeURIComponent(q)}` : ''}`,
  mlOptions: (id: string) => request<MlOptions>(`/api/datasets/${id}/ml/options`),
  train: (id: string, body: { target: string; features?: string[] }) => request<TrainResult>(`/api/datasets/${id}/ml/train`, json('POST', body)),
  predictOne: (modelId: string, values: Record<string, unknown>) =>
    request<{ model: string; value?: number; probabilities?: { label: string; p: number }[] }>(`/api/ml/models/${modelId}/predict`, json('POST', { values })),
  savedModels: () => request<SavedModel[]>('/api/ml/models'),
  saveModel: (modelId: string, datasetId: string, name: string) => request<SavedModel>(`/api/ml/models/${modelId}/save`, json('POST', { datasetId, name })),
  deleteModel: (modelId: string) => request<void>(`/api/ml/models/${modelId}`, json('DELETE')),
  scorePreview: (modelId: string, datasetId: string) => request<ScorePreview>(`/api/ml/models/${modelId}/score?dataset=${encodeURIComponent(datasetId)}`),
  scoreUrl: (modelId: string, datasetId: string) => `/api/ml/models/${modelId}/score.csv?dataset=${encodeURIComponent(datasetId)}`,
  forecast: (id: string, body: { date: string; value: string; agg: string; grain: string; periods: number }) =>
    request<ForecastResult>(`/api/datasets/${id}/ml/forecast`, json('POST', body)),
  cleanPlan: (id: string) => request<PlannedStep[]>(`/api/datasets/${id}/clean/plan`),
  clean: (id: string, steps: { kind: CleanStepKind; columns: string[] }[]) =>
    request<{ dataset: DatasetMeta; report: string[] }>(`/api/datasets/${id}/clean`, json('POST', { steps })),
  links: (id: string) => request<LinkInfo[]>(`/api/datasets/${id}/links`),
  suggestLink: (id: string, other: string) => request<LinkSuggestion>(`/api/datasets/${id}/links/suggest?other=${encodeURIComponent(other)}`),
  saveLinks: (id: string, links: DatasetLink[]) => request<DatasetMeta>(`/api/datasets/${id}/links`, json('PUT', { links })),
  pins: (id: string) => request<Pin[]>(`/api/datasets/${id}/dashboard`),
  addPin: (id: string, pin: NewPin) => request<Pin>(`/api/datasets/${id}/dashboard`, json('POST', pin)),
  updatePin: (id: string, pinId: string, patch: { title?: string; note?: string; wide?: boolean }) =>
    request<Pin>(`/api/datasets/${id}/dashboard/${pinId}`, json('PATCH', patch)),
  removePin: (id: string, pinId: string) => request<void>(`/api/datasets/${id}/dashboard/${pinId}`, json('DELETE')),
  orderPins: (id: string, order: string[]) => request<Pin[]>(`/api/datasets/${id}/dashboard/order`, json('PUT', { order })),
  conversations: (datasetId: string) => request<ConversationSummary[]>(`/api/datasets/${datasetId}/conversations`),
  createConversation: (datasetId: string) => request<Conversation>(`/api/datasets/${datasetId}/conversations`, json('POST')),
  conversation: (id: string) => request<Conversation>(`/api/conversations/${id}`),
  deleteConversation: (id: string) => request<void>(`/api/conversations/${id}`, json('DELETE')),

  async upload(file: File, onProgress?: (share: number) => void): Promise<DatasetMeta> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/datasets')
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
      xhr.onload = () => {
        let body: { error?: string } & DatasetMeta
        try { body = JSON.parse(xhr.responseText) } catch { body = { error: `Erreur ${xhr.status}` } as never }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body)
        else reject(new ApiError(xhr.status, body.error ?? (xhr.status === 413 ? 'Fichier trop volumineux.' : `Erreur ${xhr.status}`)))
      }
      xhr.onerror = () => reject(new ApiError(0, 'Envoi impossible : vérifiez la connexion.'))
      const form = new FormData()
      form.append('file', file)
      xhr.send(form)
    })
  },
}

export type StreamEvent =
  | { event: 'turn'; data: { id: string; question: string; label?: string; engine: string; model: string; title: string } }
  | { event: 'text'; data: { text: string } }
  | { event: 'tool_start'; data: { id: string; name: string; input: Record<string, unknown> } }
  | { event: 'tool_end'; data: { id: string; result: ToolOutput } }
  | { event: 'done'; data: { usage: { inputTokens: number; outputTokens: number }; durationMs: number } }
  | { event: 'error'; data: { message: string } }

/** Envoie une question et lit la réponse en flux (Server-Sent Events). */
export async function ask(
  conversationId: string,
  body: { text: string; label?: string; engine: string; model: string },
  apiKey: string,
  onEvent: (e: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-anthropic-key': apiKey } : {}) },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}))
    throw new ApiError(res.status, (err as { error?: string }).error ?? `Erreur ${res.status}`)
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let idx
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      let event = 'message', data = ''
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      if (data) onEvent({ event, data: JSON.parse(data) } as StreamEvent)
    }
  }
}
