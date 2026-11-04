// Rendu d'une spécification de graphique avec ECharts (thème clair ou sombre).
import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, HeatmapChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent, VisualMapComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

import { fmtCompact, fmtNumber } from '../format'
import { useTheme } from '../theme'
import type { ChartSpec } from '../types'

echarts.use([BarChart, LineChart, PieChart, ScatterChart, HeatmapChart, GridComponent, LegendComponent, TooltipComponent, VisualMapComponent, CanvasRenderer])

const PALETTE = {
  light: ['#3437C6', '#0F9D84', '#C98207', '#B4489B', '#2C8FD6', '#7C9A2E', '#6B7280', '#D2463A'],
  dark: ['#8D90FF', '#3CCFB2', '#F0B43C', '#E07CCB', '#5CB3F2', '#A8C657', '#9CA3AF', '#F2766B'],
}

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))

function buildOption(spec: ChartSpec, dark: boolean): echarts.EChartsCoreOption {
  const colors = PALETTE[dark ? 'dark' : 'light']
  const text = dark ? '#C9CDD8' : '#4A5168'
  const rule = dark ? '#242C3F' : '#E6E8E3'
  const { columns, rows } = spec.data
  const ix = columns.indexOf(spec.x)
  const valueAxis = { type: 'value', axisLabel: { color: text, formatter: (v: number) => fmtCompact(v) }, splitLine: { lineStyle: { color: rule } } }
  const catAxis = (data: unknown[]) => ({
    type: 'category', data, axisLabel: { color: text, hideOverlap: true }, axisLine: { lineStyle: { color: rule } }, axisTick: { show: false },
  })
  const base = {
    color: colors,
    textStyle: { fontFamily: 'Instrument Sans Variable, system-ui, sans-serif' },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => (typeof v === 'number' ? fmtNumber(v) : v), confine: true },
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    animationDuration: 400,
  }

  if (spec.type === 'pie') {
    const iy = columns.indexOf(spec.y[0])
    return {
      ...base,
      tooltip: { trigger: 'item', valueFormatter: (v: number) => fmtNumber(v) },
      legend: { orient: 'vertical', right: 0, top: 'middle', textStyle: { color: text }, icon: 'roundRect' },
      series: [{
        type: 'pie', radius: ['48%', '74%'], center: ['36%', '54%'], avoidLabelOverlap: true,
        itemStyle: { borderColor: dark ? '#141A28' : '#FFFFFF', borderWidth: 2 }, label: { show: false },
        data: rows.map((r) => ({ name: String(r[ix]), value: num(r[iy]) })),
      }],
    }
  }

  if (spec.type === 'heatmap') {
    const iy = columns.indexOf(spec.series ?? columns[1])
    const iv = columns.indexOf(spec.y[0])
    const xs = [...new Set(rows.map((r) => String(r[ix])))]
    const ys = [...new Set(rows.map((r) => String(r[iy])))]
    const values = rows.map((r) => num(r[iv]) ?? 0)
    const min = Math.min(...values), max = Math.max(...values)
    const symmetric = min < 0 && max > 0
    return {
      ...base,
      tooltip: { position: 'top', valueFormatter: (v: unknown) => (Array.isArray(v) ? fmtNumber(Number(v[2])) : String(v)) },
      grid: { ...base.grid, bottom: 48 },
      xAxis: { ...catAxis(xs), axisLabel: { color: text, rotate: 30 } },
      yAxis: catAxis(ys),
      visualMap: {
        min: symmetric ? -Math.max(-min, max) : min, max: symmetric ? Math.max(-min, max) : max, calculable: true, orient: 'horizontal', left: 'center', bottom: 0,
        textStyle: { color: text }, inRange: { color: symmetric ? [colors[7], dark ? '#1A2133' : '#F4F5F2', colors[0]] : [dark ? '#1A2133' : '#EEF0FB', colors[0]] },
      },
      series: [{
        type: 'heatmap', data: rows.map((r) => [xs.indexOf(String(r[ix])), ys.indexOf(String(r[iy])), num(r[iv])]),
        label: { show: xs.length * ys.length <= 100, color: text, formatter: (p: { value: number[] }) => fmtNumber(Number(p.value[2])) },
      }],
    }
  }

  if (spec.type === 'scatter') {
    const iy = columns.indexOf(spec.y[0])
    const groups = spec.series ? [...new Set(rows.map((r) => String(r[columns.indexOf(spec.series!)])))] : [spec.y[0]]
    return {
      ...base,
      tooltip: { trigger: 'item' },
      legend: groups.length > 1 ? { top: 0, textStyle: { color: text } } : undefined,
      xAxis: { ...valueAxis, name: spec.x, nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: text }, scale: true },
      yAxis: { ...valueAxis, name: spec.y[0], nameTextStyle: { color: text }, scale: true },
      series: groups.map((g) => ({
        type: 'scatter', name: g, symbolSize: 7, itemStyle: { opacity: 0.75 },
        data: rows.filter((r) => !spec.series || String(r[columns.indexOf(spec.series)]) === g).map((r) => [num(r[ix]), num(r[iy])]),
      })),
    }
  }

  // Barres, lignes, aires, histogrammes : catégories en x, une série par colonne y (ou par valeur de `series`).
  const horizontal = spec.type === 'horizontal_bar'
  const kind = spec.type === 'line' || spec.type === 'area' ? 'line' : 'bar'
  let categories: string[]
  let series: { name: string; values: (number | null)[] }[]
  if (spec.series) {
    const is = columns.indexOf(spec.series), iy = columns.indexOf(spec.y[0])
    categories = [...new Set(rows.map((r) => String(r[ix])))]
    const names = [...new Set(rows.map((r) => String(r[is])))]
    series = names.map((n) => ({
      name: n,
      values: categories.map((c) => num(rows.find((r) => String(r[ix]) === c && String(r[is]) === n)?.[iy])),
    }))
  } else {
    categories = rows.map((r) => String(r[ix]))
    series = spec.y.map((y) => ({ name: y, values: rows.map((r) => num(r[columns.indexOf(y)])) }))
  }
  const cat = catAxis(horizontal ? [...categories].reverse() : categories)
  return {
    ...base,
    legend: series.length > 1 ? { top: 0, textStyle: { color: text }, icon: 'roundRect' } : undefined,
    grid: { ...base.grid, top: series.length > 1 ? 36 : 16 },
    xAxis: horizontal ? valueAxis : cat,
    yAxis: horizontal ? cat : valueAxis,
    series: series.map((s, i) => ({
      type: kind,
      name: s.name,
      data: horizontal ? [...s.values].reverse() : s.values,
      stack: spec.stacked ? 'total' : undefined,
      smooth: kind === 'line' ? 0.25 : undefined,
      showSymbol: kind === 'line' && categories.length <= 24,
      connectNulls: false,
      barMaxWidth: 36,
      barCategoryGap: spec.type === 'histogram' ? '4%' : '30%',
      itemStyle: kind === 'bar' ? { borderRadius: horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0] } : undefined,
      lineStyle: kind === 'line' ? { width: 2.2, type: s.name === 'prévision' ? 'dashed' : 'solid' } : undefined,
      areaStyle: spec.type === 'area' ? { opacity: 0.12 } : undefined,
      color: colors[i % colors.length],
    })),
  }
}

export function Chart({ spec, height = 300 }: { spec: ChartSpec; height?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const { dark } = useTheme()
  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    chart.setOption(buildOption(spec, dark))
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(ref.current)
    return () => { ro.disconnect(); chart.dispose() }
  }, [spec, dark])
  const h = spec.type === 'horizontal_bar' ? Math.max(height, 34 * Math.min(spec.data.rows.length, 15) + 40) : height
  return <div ref={ref} className="chart-canvas" style={{ height: h }} role="img" aria-label={spec.title} />
}

export function ChartFigure({ spec, height }: { spec: ChartSpec; height?: number }) {
  return (
    <figure className="figure">
      <figcaption>
        <strong>{spec.title}</strong>
        {spec.subtitle && <span>{spec.subtitle}</span>}
      </figcaption>
      <Chart spec={spec} height={height} />
    </figure>
  )
}
