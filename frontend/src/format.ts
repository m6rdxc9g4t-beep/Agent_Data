// Mise en forme française des nombres, tailles et dates.
const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 })
const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })

export const fmtInt = (n: number) => nf0.format(n)

export function fmtNumber(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 1e4 || Number.isInteger(v)) return nf0.format(v)
  return nf.format(Number(v.toPrecision(6)))
}

export function fmtCompact(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `${nf.format(+(v / 1e9).toFixed(1))} Md`
  if (a >= 1e6) return `${nf.format(+(v / 1e6).toFixed(1))} M`
  if (a >= 1e4) return `${nf.format(+(v / 1e3).toFixed(1))} k`
  return fmtNumber(v)
}

export function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return fmtNumber(v)
  if (typeof v === 'boolean') return v ? 'vrai' : 'faux'
  const s = String(v)
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})( 00:00:00)?$/)
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`
  return s
}

export function fmtBytes(b: number): string {
  const u = ['o', 'Ko', 'Mo', 'Go']
  let i = 0
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++ }
  return `${i ? nf.format(+b.toFixed(1)) : b} ${u[i]}`
}

export const fmtPct = (x: number, digits = 1) => `${nf.format(+(x * 100).toFixed(digits))} %`

export function fmtRelative(iso: string): string {
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return "à l'instant"
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`
  if (diff < 86400 && new Date().getDate() === d.getDate()) return `aujourd'hui, ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

export const plural = (n: number, word: string, many = `${word}s`) => `${fmtInt(n)} ${n > 1 ? many : word}`
