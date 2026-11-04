// Icônes des analyses rapides (sous-ensemble explicite de lucide-react).
import {
  Boxes, BrainCircuit, Briefcase, ChartColumn, ChartScatter, ChartSpline, Gauge, Grid2x2X, LayoutDashboard,
  Lightbulb, Network, ShieldCheck, Sigma, Sparkles, Telescope, TrendingUp, type LucideIcon,
} from 'lucide-react'

const ICONS: Record<string, LucideIcon> = {
  telescope: Telescope,
  sigma: Sigma,
  'chart-column': ChartColumn,
  'shield-check': ShieldCheck,
  'grid-2x2-x': Grid2x2X,
  'scatter-chart': ChartScatter,
  network: Network,
  boxes: Boxes,
  'trending-up': TrendingUp,
  'chart-spline': ChartSpline,
  'brain-circuit': BrainCircuit,
  gauge: Gauge,
  lightbulb: Lightbulb,
  'layout-dashboard': LayoutDashboard,
  briefcase: Briefcase,
}

export function AnalysisIcon({ name, size = 16 }: { name: string; size?: number }) {
  const Icon = ICONS[name] ?? Sparkles
  return <Icon size={size} strokeWidth={1.8} aria-hidden />
}
