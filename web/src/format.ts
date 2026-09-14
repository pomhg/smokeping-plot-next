import type { Lang } from './i18n';

export function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  if (v >= 100) return `${v.toFixed(0)} ms`;
  if (v >= 10) return `${v.toFixed(1)} ms`;
  return `${v.toFixed(2)} ms`;
}

/** Compact axis label: "12", "1.5k" (ms). */
export function fmtMsAxis(v: number): string {
  if (v >= 1000) return `${+(v / 1000).toFixed(v >= 10000 ? 0 : 1)}s`;
  if (v >= 10) return `${Math.round(v)}`;
  if (v >= 1) return `${+v.toFixed(1)}`;
  return `${+v.toFixed(2)}`;
}

export function fmtLoss(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v === 0) return '0%';
  if (v >= 10) return `${v.toFixed(0)}%`;
  return `${v.toFixed(1)}%`;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function fmtTime(ts: number, withSeconds = false): string {
  const d = new Date(ts * 1000);
  const s = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${s}:${pad(d.getSeconds())}` : s;
}

export function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtDateTime(ts: number): string {
  return `${fmtDate(ts)} ${fmtTime(ts)}`;
}

export function fmtDuration(sec: number, lang: Lang): string {
  const units: [number, string, string][] = [
    [86400, 'd', '天'],
    [3600, 'h', '小时'],
    [60, 'm', '分钟'],
    [1, 's', '秒'],
  ];
  for (const [n, en, zh] of units) {
    if (sec >= n) {
      const v = Math.floor(sec / n);
      return lang === 'zh' ? `${v} ${zh}` : `${v}${en}`;
    }
  }
  return lang === 'zh' ? '0 秒' : '0s';
}

/** Loss → colour, in the spirit of smokeping's median-line legend. */
export function lossColor(loss: number): string {
  if (loss <= 0) return '#16a34a';
  if (loss <= 5) return '#0ea5e9';
  if (loss <= 10) return '#2563eb';
  if (loss <= 25) return '#7c3aed';
  if (loss <= 50) return '#c026d3';
  return '#dc2626';
}

export const lossLegend: { label: string; color: string }[] = [
  { label: '0%', color: lossColor(0) },
  { label: '≤5%', color: lossColor(5) },
  { label: '≤10%', color: lossColor(10) },
  { label: '≤25%', color: lossColor(25) },
  { label: '≤50%', color: lossColor(50) },
  { label: '>50%', color: lossColor(100) },
];
