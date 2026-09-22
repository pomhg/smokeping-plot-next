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

/** Loss → colour. Monochrome-first palette: 0 % is ink, escalating through
 *  classic link-blue, purple, magenta and red as packets go missing. */
const LOSS_LIGHT = ['#1e1e1e', '#0000ee', '#7a00d6', '#c400a8', '#f0007a', '#e40000'];
const LOSS_DARK = ['#fefefe', '#7d9bff', '#b48cff', '#ea8cff', '#ff7cb8', '#ff5555'];

function lossIndex(loss: number): number {
  if (loss <= 0) return 0;
  if (loss <= 5) return 1;
  if (loss <= 10) return 2;
  if (loss <= 25) return 3;
  if (loss <= 50) return 4;
  return 5;
}

export function lossColor(loss: number, dark = false): string {
  return (dark ? LOSS_DARK : LOSS_LIGHT)[lossIndex(loss)];
}

export const LOSS_LABELS = ['0%', '≤5%', '≤10%', '≤25%', '≤50%', '>50%'];

export function lossLegend(dark: boolean): { label: string; color: string }[] {
  return LOSS_LABELS.map((label, i) => ({ label, color: (dark ? LOSS_DARK : LOSS_LIGHT)[i] }));
}

/** Two-unit duration for "down for …" style labels: 45s, 12m, 3h 5m, 2d 4h. */
export function fmtSince(sec: number, lang: Lang): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const zh = lang === 'zh';
  if (d > 0) return zh ? `${d} 天${h ? ` ${h} 小时` : ''}` : `${d}d${h ? ` ${h}h` : ''}`;
  if (h > 0) return zh ? `${h} 小时${m ? ` ${m} 分` : ''}` : `${h}h${m ? ` ${m}m` : ''}`;
  if (m > 0) return zh ? `${m} 分钟` : `${m}m`;
  return zh ? `${s} 秒` : `${s}s`;
}
