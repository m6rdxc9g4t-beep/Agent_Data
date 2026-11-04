import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, describe, expect, it } from 'vitest'

import { buildServer } from '../src/agent/claude-plan.js'
import type { AgentEvent } from '../src/agent/engines.js'
import { loadSample } from './helpers.js'

const sample = await loadSample('ventes.csv')
afterAll(() => sample.cleanup())

describe('moteur Claude (forfait)', () => {
  it('expose les outils de DataMind par MCP et émet le déroulé', async () => {
    const events: AgentEvent[] = []
    const server = buildServer({ system: '', history: [], question: '', ctx: { db: sample.db, profile: sample.profile }, onEvent: (e) => events.push(e) })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await (server as any).instance.connect(a)
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(b)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['create_chart', 'forecast', 'predict', 'run_sql', 'segment'])
    const res: any = await client.callTool({ name: 'run_sql', arguments: { sql: 'SELECT count(*) AS n FROM data' } })
    expect(res.content[0].text).toContain('30')
    expect(res.isError).toBe(false)
    const bad: any = await client.callTool({ name: 'run_sql', arguments: { sql: 'DROP TABLE data' } })
    expect(bad.isError).toBe(true)
    const chart: any = await client.callTool({ name: 'create_chart', arguments: { type: 'bar', title: 't', sql: 'SELECT region, sum(montant) AS total FROM data GROUP BY 1', x: 'region', y: ['total'] } })
    expect(chart.isError).toBe(false)
    expect(events.filter((e) => e.type === 'tool_end').length).toBe(3)
    await client.close()
  })
})
