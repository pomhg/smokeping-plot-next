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

const SMOKE_RGB_LIGHT = '71,85,105';
const SMOKE_RGB_DARK = '148,163,184';

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

export function SmokeChart({ points, from, to, bucket, height = 300, compact = false, logScale = false, onZoom }: Props) {
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
    const left = compact ? 6 : 48;
    const right = compact ? 6 : 12;
    const top = compact ? 6 : 10;
    const lossH = compact ? 4 : 6;
    const xAxisH = compact ? 0 : 20;
    const bottom = height - xAxisH - lossH - 2;
    let maxV = 0;
    let minV = Infinity;
    for (const p of points) {
      const hi = compact ? (p.p75 ?? p.median) : p.max;
      if (hi !== null && hi !== undefined && hi > maxV) maxV = hi;
      if (p.min !== null && p.min < minV) minV = p.min;
    }
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
    }
    return { left, right, top, bottom, lossH, plotW: Math.max(1, width - left - right), plotH: Math.max(1, bottom - top), yMin, yMax, log };
  }, [points, width, height, compact, logScale]);

  const xOf = useCallback((ts: number) => layout.left + ((ts - from) / Math.max(1, to - from)) * layout.plotW, [layout, from, to]);
  const tsOf = useCallback((x: number) => from + ((x - layout.left) / layout.plotW) * (to - from), [layout, from, to]);
  const yOf = useCallback(
    (v: number) => {
      const { yMin, yMax, log, top, plotH } = layout;
      let f: number;
      if (log) f = Math.log(Math.max(v, yMin) / yMin) / Math.log(yMax / yMin);
      else f = v / yMax;
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
    const gridColor = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
    const axisText = dark ? '#9aa4b2' : '#6b7280';
    const smokeRGB = dark ? SMOKE_RGB_DARK : SMOKE_RGB_LIGHT;
    const { left, top, bottom, lossH, plotW, plotH } = layout;
    const gap = bucket * 1.5;

    // grid + y axis
    ctx.font = `${compact ? 10 : 11}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'middle';
    const yt = layout.log ? logTicks(layout.yMin, layout.yMax) : linearTicks(layout.yMax, compact ? 3 : 5);
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
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
    if (!compact) {
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      ctx.moveTo(left + 0.5, top);
      ctx.lineTo(left + 0.5, bottom + lossH + 2);
      ctx.stroke();
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
        ctx.strokeStyle = lossColor(Math.max(p.loss, prev.loss));
        ctx.beginPath();
        ctx.moveTo(xOf(prev.ts + bucket / 2), yOf(prev.median));
        ctx.lineTo(x, y);
        ctx.stroke();
      } else {
        const next = points[i + 1];
        if (!next || next.median === null || next.ts - p.ts > gap) {
          ctx.fillStyle = lossColor(p.loss);
          ctx.beginPath();
          ctx.arc(x, y, compact ? 1.5 : 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();

    // loss strip
    for (const p of points) {
      if (p.loss <= 0) continue;
      const x0 = xOf(p.ts);
      const w = Math.max(1, xOf(p.ts + bucket) - x0);
      ctx.fillStyle = lossColor(p.loss);
      ctx.globalAlpha = p.loss >= 100 ? 1 : 0.45 + (p.loss / 100) * 0.55;
      ctx.fillRect(x0, bottom + 2, w, lossH);
    }
    ctx.globalAlpha = 1;

    // drag selection
    if (drag) {
      const a = Math.min(drag.x0, drag.x1);
      const b = Math.max(drag.x0, drag.x1);
      ctx.fillStyle = dark ? 'rgba(96,165,250,0.18)' : 'rgba(37,99,235,0.12)';
      ctx.fillRect(a, top, b - a, plotH);
      ctx.strokeStyle = dark ? 'rgba(96,165,250,0.7)' : 'rgba(37,99,235,0.6)';
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
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom + lossH + 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (p.median !== null) {
        ctx.fillStyle = lossColor(p.loss);
        ctx.strokeStyle = dark ? '#0f1217' : '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, yOf(p.median), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }, [points, width, height, layout, from, to, bucket, compact, theme, hoverIdx, drag, xOf, yOf]);

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
            <span className="dot" style={{ background: lossColor(hp.loss) }} />
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
            {t('loss')}: <b style={{ color: hp.loss > 0 ? lossColor(hp.loss) : undefined }}>{fmtLoss(hp.loss)}</b>
            <span className="muted"> ({hp.recv}/{hp.sent})</span>
          </div>
        </div>
      )}
    </div>
  );
}
