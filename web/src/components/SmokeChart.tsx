import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Point } from '../api';
import { fmtDateTime, fmtLoss, fmtMs, fmtMsAxis, fmtTime, lossColor } from '../format';
import { useTheme } from '../theme';
import { useI18n } from '../i18n';

interface Props {
  points: Point[];
  from: number;
  to: number;
  bucket: number;
  height?: number;
  /** Overview cards: no axes labels, tighter padding, tooltip still works. */
  compact?: boolean;
  /** Row sparkline: compact, plus no background, grid or frame. */
  bare?: boolean;
  logScale?: boolean;
  onZoom?: (from: number, to: number) => void;
}

interface Layout {
  left: number;
  right: number;
  top: number;
  bottom: number; // y of plot bottom (loss strip sits below)
  lossH: number;
  plotW: number;
  plotH: number;
  yMin: number;
  yMax: number;
  log: boolean;
}

const INK_LIGHT = '30,30,30';
const INK_DARK = '254,254,254';

// 1-bit style dot texture for the plot background, cached per theme.
const patternCache = new Map<string, CanvasPattern | null>();
function dotPattern(ctx: CanvasRenderingContext2D, rgb: string, dpr: number): CanvasPattern | null {
  const key = `${rgb}@${dpr}`;
  if (patternCache.has(key)) return patternCache.get(key)!;
  const size = 6;
  const c = document.createElement('canvas');
  c.width = size * dpr;
  c.height = size * dpr;
  const g = c.getContext('2d');
  if (!g) return null;
  g.scale(dpr, dpr);
  g.fillStyle = `rgba(${rgb},0.16)`;
  g.fillRect(0, 0, 1, 1);
  const pat = ctx.createPattern(c, 'repeat');
  if (pat) {
    const m = new DOMMatrix();
    m.a = 1 / dpr;
    m.d = 1 / dpr;
    pat.setTransform(m);
  }
  patternCache.set(key, pat);
  return pat;
}

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const m = v / base;
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return nice * base;
}

function linearTicks(max: number, count: number): number[] {
  const raw = max / count;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const m = raw / base;
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * base;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

function logTicks(min: number, max: number): number[] {
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= min && v <= max) out.push(v);
    }
  }
  return out;
}

const X_STEPS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 1209600, 2592000];

function xTicks(from: number, to: number, plotW: number, compact: boolean): { ts: number; label: string }[] {
  const span = to - from;
  const want = Math.max(2, Math.min(compact ? 4 : 10, Math.floor(plotW / (compact ? 70 : 90))));
  let step = X_STEPS[X_STEPS.length - 1];
  for (const s of X_STEPS) {
    if (span / s <= want) {
      step = s;
      break;
    }
  }
  const tz = new Date().getTimezoneOffset() * 60;
  const out: { ts: number; label: string }[] = [];
  const first = Math.ceil((from - tz) / step) * step + tz;
  for (let t = first; t <= to; t += step) {
    const d = new Date(t * 1000);
    let label: string;
    if (step >= 86400) label = `${d.getMonth() + 1}/${d.getDate()}`;
    else if (span > 86400 && d.getHours() === 0 && d.getMinutes() === 0) label = `${d.getMonth() + 1}/${d.getDate()}`;
    else label = fmtTime(t);
    out.push({ ts: t, label });
  }
  return out;
}

export function SmokeChart({ points, from, to, bucket, height = 300, compact = false, bare = false, logScale = false, onZoom }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);
  const dragRef = useRef<{ x0: number; x1: number; pointerId: number } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const { resolved: theme } = useTheme();
  const { t } = useI18n();

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    setWidth(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  const layout = useMemo<Layout>(() => {
    const left = bare ? 0 : compact ? 6 : 48;
    const right = bare ? 0 : compact ? 6 : 12;
    const top = bare ? 2 : compact ? 6 : 10;
    const lossH = bare ? 3 : compact ? 4 : 6;
    const xAxisH = compact ? 0 : 20;
    const bottom = height - xAxisH - lossH - 2;
    // Y range: the smoke's 98th percentile of per-bucket maxima (so one
    // stray 2 s spike does not flatten a 60 ms line) but never less than
    // 1.5x the busiest inter-quartile band. Anything above is clipped.
    const highs: number[] = [];
    let bandMax = 0;
    let minV = Infinity;
    for (const p of points) {
      const hi = compact ? p.p75 ?? p.median : p.max;
      if (hi !== null && hi !== undefined) highs.push(hi);
      const band = p.p75 ?? p.median;
      if (band !== null && band !== undefined && band > bandMax) bandMax = band;
      if (p.min !== null && p.min < minV) minV = p.min;
    }
    highs.sort((a, b) => a - b);
    let maxV = highs.length ? highs[Math.min(highs.length - 1, Math.floor(highs.length * 0.98))] : 0;
    if (!compact) maxV = Math.max(maxV, bandMax * 1.5);
    if (highs.length && logScale) maxV = highs[highs.length - 1];
    if (!Number.isFinite(minV)) minV = 0.1;
    if (maxV <= 0) maxV = 1;
    const log = logScale && !compact;
    let yMax: number;
    let yMin: number;
    if (log) {
      yMin = Math.pow(10, Math.floor(Math.log10(Math.max(minV, 0.01))));
      yMax = Math.pow(10, Math.ceil(Math.log10(maxV * 1.05)));
      if (yMax <= yMin) yMax = yMin * 10;
    } else {
      yMin = 0;
      yMax = niceCeil(maxV * (compact ? 1.15 : 1.05));
      if (bare) {
        // row sparklines are ~30px tall: frame the data instead of starting
        // at 0, otherwise every healthy line is flat
        let lo = Infinity;
        let hi = 0;
        for (const p of points) {
          if (p.p25 !== null && p.p25 < lo) lo = p.p25;
          if (p.p75 !== null && p.p75 > hi) hi = p.p75;
        }
        if (Number.isFinite(lo) && hi > 0) {
          const pad = Math.max((hi - lo) * 0.15, hi * 0.02);
          yMin = Math.max(0, lo - pad);
          yMax = hi + pad;
        }
      }
    }
    return { left, right, top, bottom, lossH, plotW: Math.max(1, width - left - right), plotH: Math.max(1, bottom - top), yMin, yMax, log };
  }, [points, width, height, compact, bare, logScale]);

  const xOf = useCallback((ts: number) => layout.left + ((ts - from) / Math.max(1, to - from)) * layout.plotW, [layout, from, to]);
  const tsOf = useCallback((x: number) => from + ((x - layout.left) / layout.plotW) * (to - from), [layout, from, to]);
  const yOf = useCallback(
    (v: number) => {
      const { yMin, yMax, log, top, plotH } = layout;
      let f: number;
      if (log) f = Math.log(Math.max(v, yMin) / yMin) / Math.log(yMax / yMin);
      else f = (v - yMin) / (yMax - yMin);
      return top + plotH - Math.min(1, Math.max(0, f)) * plotH;
    },
    [layout],
  );

  // ------------------------------------------------------------ drawing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const dark = theme === 'dark';
    const ink = dark ? INK_DARK : INK_LIGHT;
    const gridColor = `rgba(${ink},0.22)`;
    const axisText = `rgba(${ink},0.7)`;
    const smokeRGB = ink;
    const { left, top, bottom, lossH, plotW, plotH } = layout;
    const gap = bucket * 1.5;

    // plot background: paper + dot texture + frame
    if (!bare) {
      ctx.fillStyle = dark ? '#121212' : '#fefefe';
      ctx.fillRect(left, top, plotW, plotH);
      const pat = dotPattern(ctx, ink, dpr);
      if (pat) {
        ctx.fillStyle = pat;
        ctx.fillRect(left, top, plotW, plotH);
      }
    }

    // grid + y axis
    if (!bare) {
    ctx.font = `${compact ? 9 : 10.5}px "JetBrains Mono", ui-monospace, Menlo, monospace`;
    ctx.textBaseline = 'middle';
    const yt = layout.log ? logTicks(layout.yMin, layout.yMax) : linearTicks(layout.yMax, compact ? 3 : 5);
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([1, 3]);
    ctx.fillStyle = axisText;
    ctx.textAlign = 'right';
    for (const v of yt) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + plotW, y);
      ctx.stroke();
      if (!compact) ctx.fillText(fmtMsAxis(v), left - 6, y);
    }
    // x axis
    const xt = xTicks(from, to, plotW, compact);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const { ts, label } of xt) {
      const x = Math.round(xOf(ts)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom + lossH + 2);
      ctx.stroke();
      if (!compact) ctx.fillText(label, x, bottom + lossH + 6);
    }
    ctx.setLineDash([]);
    // frame around the plot
    ctx.strokeStyle = `rgb(${ink})`;
    ctx.strokeRect(left + 0.5, top + 0.5, plotW - 1, plotH - 1);
    }

    // clip to plot for data
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top - 1, plotW, plotH + 2);
    ctx.clip();

    // smoke bands: segments of consecutive points without gaps
    // Compact sparklines only show the inter-quartile band: the y-axis is
    // scaled to p75 there, and a clipped min–max band would just be a wall.
    const bands: [keyof Point, keyof Point, number][] = compact
      ? [['p25', 'p75', 0.3]]
      : [
          ['min', 'max', 0.16],
          ['p25', 'p75', 0.32],
        ];
    for (const [loKey, hiKey, alpha] of bands) {
      ctx.fillStyle = `rgba(${smokeRGB},${alpha})`;
      let i = 0;
      while (i < points.length) {
        // collect a run
        let j = i;
        while (
          j + 1 < points.length &&
          points[j + 1].ts - points[j].ts <= gap &&
          points[j + 1][hiKey] !== null &&
          points[j][hiKey] !== null
        )
          j++;
        const run = points.slice(i, j + 1).filter((p) => p[hiKey] !== null && p[loKey] !== null);
        if (run.length === 1) {
          const p = run[0];
          const x = xOf(p.ts + bucket / 2);
          const w = Math.max(1.5, xOf(p.ts + bucket) - xOf(p.ts));
          const yHi = yOf(p[hiKey] as number);
          const yLo = yOf(p[loKey] as number);
          ctx.fillRect(x - w / 2, yHi, w, Math.max(1, yLo - yHi));
        } else if (run.length > 1) {
          ctx.beginPath();
          run.forEach((p, k) => {
            const x = xOf(p.ts + bucket / 2);
            const y = yOf(p[hiKey] as number);
            if (k === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          for (let k = run.length - 1; k >= 0; k--) {
            const p = run[k];
            ctx.lineTo(xOf(p.ts + bucket / 2), yOf(p[loKey] as number));
          }
          ctx.closePath();
          ctx.fill();
        }
        i = j + 1;
      }
    }

    // median line, coloured by loss
    ctx.lineWidth = compact ? 1.5 : 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.median === null) continue;
      const x = xOf(p.ts + bucket / 2);
      const y = yOf(p.median);
      const prev = i > 0 ? points[i - 1] : null;
      if (prev && prev.median !== null && p.ts - prev.ts <= gap) {
        ctx.strokeStyle = lossColor(Math.max(p.loss, prev.loss), dark);
        ctx.beginPath();
        ctx.moveTo(xOf(prev.ts + bucket / 2), yOf(prev.median));
        ctx.lineTo(x, y);
        ctx.stroke();
      } else {
        const next = points[i + 1];
        if (!next || next.median === null || next.ts - p.ts > gap) {
          ctx.fillStyle = lossColor(p.loss, dark);
          const r = compact ? 1.5 : 2;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
      }
    }
    ctx.restore();

    // loss strip
    for (const p of points) {
      if (p.loss <= 0) continue;
      const x0 = xOf(p.ts);
      const w = Math.max(1, xOf(p.ts + bucket) - x0);
      ctx.fillStyle = lossColor(p.loss, dark);
      ctx.globalAlpha = p.loss >= 100 ? 1 : 0.45 + (p.loss / 100) * 0.55;
      ctx.fillRect(x0, bottom + 2, w, lossH);
    }
    ctx.globalAlpha = 1;

    // compact cards have no axis; label the top gridline so sparklines of
    // very different magnitudes (0.6 ms vs 60 ms) can be told apart
    if (compact && !bare && points.length > 0) {
      const label = `${fmtMsAxis(layout.yMax)}ms`;
      ctx.font = '9px "JetBrains Mono", ui-monospace, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const w = ctx.measureText(label).width + 6;
      ctx.fillStyle = dark ? '#121212' : '#fefefe';
      ctx.fillRect(left + 1, top + 1, w, 12);
      ctx.fillStyle = axisText;
      ctx.fillText(label, left + 4, top + 2.5);
    }

    // drag selection
    if (drag) {
      const a = Math.min(drag.x0, drag.x1);
      const b = Math.max(drag.x0, drag.x1);
      ctx.fillStyle = 'rgba(243,134,161,0.28)';
      ctx.fillRect(a, top, b - a, plotH);
      ctx.strokeStyle = `rgb(${ink})`;
      ctx.beginPath();
      ctx.moveTo(a + 0.5, top);
      ctx.lineTo(a + 0.5, bottom);
      ctx.moveTo(b + 0.5, top);
      ctx.lineTo(b + 0.5, bottom);
      ctx.stroke();
    }

    // crosshair
    if (hoverIdx !== null && points[hoverIdx]) {
      const p = points[hoverIdx];
      const x = Math.round(xOf(p.ts + bucket / 2)) + 0.5;
      ctx.strokeStyle = `rgb(${ink})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom + lossH + 2);
      ctx.stroke();
      if (p.median !== null) {
        const y = yOf(p.median);
        ctx.fillStyle = dark ? '#121212' : '#fefefe';
        ctx.fillRect(x - 4, y - 4, 8, 8);
        ctx.fillStyle = lossColor(p.loss, dark);
        ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
      }
    }
  }, [points, width, height, layout, from, to, bucket, compact, bare, theme, hoverIdx, drag, xOf, yOf]);

  // ------------------------------------------------------------ interaction
  const nearest = useCallback(
    (x: number): number | null => {
      if (points.length === 0) return null;
      const ts = tsOf(x) - bucket / 2;
      let lo = 0;
      let hi = points.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid].ts < ts) lo = mid + 1;
        else hi = mid;
      }
      let best = lo;
      if (lo > 0 && Math.abs(points[lo - 1].ts - ts) < Math.abs(points[lo].ts - ts)) best = lo - 1;
      // ignore if the cursor is far away from any bucket (a gap)
      if (Math.abs(points[best].ts - ts) > Math.max(bucket * 2, (to - from) / Math.max(1, layout.plotW) * 12)) return null;
      return best;
    },
    [points, tsOf, bucket, from, to, layout.plotW],
  );

  const localX = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return Math.min(layout.left + layout.plotW, Math.max(layout.left, e.clientX - r.left));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const x = localX(e);
    if (dragRef.current && e.pointerId === dragRef.current.pointerId) {
      dragRef.current.x1 = x;
      setDrag({ x0: dragRef.current.x0, x1: x });
    }
    setHoverIdx(nearest(x));
    setHoverX(x);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!onZoom || e.button !== 0) return;
    const x = localX(e);
    dragRef.current = { x0: x, x1: x, pointerId: e.pointerId };
    canvasRef.current?.setPointerCapture(e.pointerId);
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    canvasRef.current?.releasePointerCapture(e.pointerId);
    const a = Math.min(d.x0, d.x1);
    const b = Math.max(d.x0, d.x1);
    if (b - a >= 8 && onZoom) {
      const f = Math.floor(tsOf(a));
      const t2 = Math.ceil(tsOf(b));
      if (t2 - f >= 60) onZoom(f, t2);
    }
  };
  const onPointerLeave = (e: React.PointerEvent) => {
    if (!dragRef.current) setHoverIdx(null);
    else endDrag(e);
  };

  const hp = hoverIdx !== null ? points[hoverIdx] : null;
  const dark = theme === 'dark';
  const tipLeft = hoverX > width / 2;

  return (
    <div ref={wrapRef} className={`smoke-chart${compact ? ' compact' : ''}`} style={{ height }}>
      <canvas
        ref={canvasRef}
        style={{ width, height, touchAction: 'pan-y', cursor: onZoom ? 'crosshair' : 'default' }}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={onPointerLeave}
      />
      {hp && (
        <div
          className="smoke-tip"
          style={{ [tipLeft ? 'right' : 'left']: tipLeft ? width - hoverX + 10 : hoverX + 10, top: compact ? 4 : layout.top }}
        >
          <div className="smoke-tip-time">
            {bucket >= 86400 ? fmtDateTime(hp.ts) : `${fmtDateTime(hp.ts)}${bucket > 60 ? ` – ${fmtTime(hp.ts + bucket)}` : ''}`}
          </div>
          <div className="smoke-tip-row">
            <span className="dot" style={{ background: lossColor(hp.loss, dark) }} />
            {t('median')}: <b>{fmtMs(hp.median)}</b>
          </div>
          {!compact && hp.p25 !== null && (
            <div className="smoke-tip-row muted">
              25–75%: {fmtMs(hp.p25)} – {fmtMs(hp.p75)}
            </div>
          )}
          <div className="smoke-tip-row muted">
            {t('min')}/{t('max')}: {fmtMs(hp.min)} / {fmtMs(hp.max)}
          </div>
          <div className="smoke-tip-row">
            {t('loss')}: <b style={{ color: hp.loss > 0 ? lossColor(hp.loss, dark) : undefined }}>{fmtLoss(hp.loss)}</b>
            <span className="muted"> ({hp.recv}/{hp.sent})</span>
          </div>
        </div>
      )}
    </div>
  );
}
