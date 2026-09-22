import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type TargetView } from '../api';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';
import { fmtDateTime, fmtDuration, fmtLoss, fmtMs, fmtSince, fmtTime, lossColor, lossLegend } from '../format';
import { SmokeChart } from '../components/SmokeChart';
import { RANGES, RangePicker } from '../components/RangePicker';
import { Modal } from '../components/Modal';
import { CropMarks } from '../components/CropMarks';
import { downFor, statusColor, statusOf, useNow } from '../status';
import { rangeLabel } from '../components/RangePicker';

interface Props {
  targets: TargetView[];
  onEdit: (t: TargetView) => void;
  onToast: (msg: string) => void;
}

export function TargetDetail({ targets, onEdit, onToast }: Props) {
  const { id } = useParams();
  const target = targets.find((x) => String(x.id) === id);
  const { t, lang } = useI18n();
  const { resolved } = useTheme();
  const dark = resolved === 'dark';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [logScale, setLogScale] = useState(() => {
    try {
      return localStorage.getItem('spn.log') === '1';
    } catch {
      return false;
    }
  });
  const [confirmDel, setConfirmDel] = useState(false);
  const now = useNow(15_000);

  // prev / next in overview order (the API returns targets in that order)
  const idx = targets.findIndex((x) => String(x.id) === id);
  const prev = idx > 0 ? targets[idx - 1] : null;
  const next = idx >= 0 && idx < targets.length - 1 ? targets[idx + 1] : null;
  const goTo = useCallback(
    (tid: number) => navigate({ pathname: `/targets/${tid}`, search: params.get('r') ? `?r=${params.get('r')}` : '' }),
    [navigate, params],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement).closest('input, textarea, [role=dialog], [role=listbox]')) return;
      if (e.key === 'ArrowLeft' && prev) goTo(prev.id);
      else if (e.key === 'ArrowRight' && next) goTo(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next, goTo]);
  useEffect(() => {
    try {
      localStorage.setItem('spn.log', logScale ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [logScale]);

  // Range: either a preset (live, sliding window) or an explicit from/to.
  const presetKey = params.get('r') ?? (params.get('from') ? null : '3h');
  const customFrom = Number(params.get('from'));
  const customTo = Number(params.get('to'));
  const live = presetKey !== null;
  const range = RANGES.find((r) => r.key === presetKey);
  const to = live ? now : customTo;
  const from = live ? now - (range?.sec ?? 3 * 3600) : customFrom;

  const setPreset = useCallback((key: string) => setParams({ r: key }, { replace: true }), [setParams]);
  const zoomTo = useCallback((f: number, tt: number) => setParams({ from: String(f), to: String(tt) }, { replace: false }), [setParams]);

  const { data: series, isLoading } = useQuery({
    queryKey: ['series', 'target', target?.id, from, to],
    queryFn: () => api.series(target!.id, from, to, 500),
    enabled: !!target,
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });

  const del = useMutation({
    mutationFn: () => api.deleteTarget(target!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['targets'] });
      onToast(t('deleted'));
      navigate('/');
    },
  });
  const toggle = useMutation({
    mutationFn: () =>
      api.updateTarget(target!.id, {
        name: target!.name,
        host: target!.host,
        group: target!.group,
        probe: target!.probe,
        port: target!.port,
        step: target!.step,
        pings: target!.pings,
        enabled: !target!.enabled,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['targets'] }),
  });

  const stats = useMemo(() => {
    const pts = series?.points ?? [];
    let sent = 0;
    let recv = 0;
    let min = Infinity;
    let max = -Infinity;
    let wsum = 0;
    let wcount = 0;
    let upBuckets = 0;
    let iqrSum = 0;
    let iqrN = 0;
    for (const p of pts) {
      if (p.p25 !== null && p.p75 !== null) {
        iqrSum += (p.p75 - p.p25) * p.recv;
        iqrN += p.recv;
      }
      sent += p.sent;
      recv += p.recv;
      if (p.min !== null && p.min < min) min = p.min;
      if (p.max !== null && p.max > max) max = p.max;
      if (p.median !== null) {
        wsum += p.median * p.recv;
        wcount += p.recv;
      }
      if (p.recv > 0) upBuckets++;
    }
    return {
      loss: sent > 0 ? (100 * (sent - recv)) / sent : null,
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
      median: wcount > 0 ? wsum / wcount : null,
      availability: pts.length > 0 ? (100 * upBuckets) / pts.length : null,
      jitter: iqrN > 0 ? iqrSum / iqrN : null,
      sent,
      recv,
    };
  }, [series]);

  if (!target) {
    return (
      <div className="empty win">
        <div className="win-bar">
          <span className="win-title">404</span>
        </div>
        <div className="win-body empty-body">
          <h2 className="display">{t('notFound')}</h2>
          <Link to="/" className="btn">
            ← {t('back')}
          </Link>
        </div>
      </div>
    );
  }

  const st = statusOf(target, now);
  const last = target.last;
  const ageSec = last ? Math.max(0, now - last.ts) : null;
  const down = downFor(target, now);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  const legend = lossLegend(dark);
  const rangeName = live && presetKey ? rangeLabel(presetKey, lang) : t('range');
  const updated = ageSec === null ? '' : ageSec < 5 ? t('justNow') : t('ago', { t: fmtSince(ageSec, lang) });

  let nowValue = '—';
  let nowColor: string | undefined;
  let nowSub = updated;
  if (st === 'down') {
    nowValue = down === null ? t('unreachable') : down < 0 ? t('neverUp') : t('downFor', { t: fmtSince(down, lang) });
    nowColor = lossColor(100, dark);
    if (down !== null && down >= 0) nowSub = t('lastOk', { t: fmtTime(target.lastUp!) });
  } else if (st === 'stale') {
    nowValue = t('staleFor', { t: fmtSince(ageSec ?? 0, lang) });
    nowColor = 'var(--muted)';
  } else if (last && last.recv > 0) {
    nowValue = fmtMs(last.median);
    nowSub = `${t('loss')} ${fmtLoss(last.loss)} · ${updated}`;
    if (last.loss > 0) nowColor = undefined;
  }

  return (
    <div className="detail">
      <div className="detail-head">
        <CropMarks />
        <Link to="/" className="btn ghost back" aria-label={t('back')}>
          ←
        </Link>
        <div className="detail-title">
          <div className="meta">
            <span className={`led st-${st}`} style={{ background: statusColor(target, now, dark) }} />
            {target.group || t('ungrouped')} / {target.probe.toUpperCase()}
            {target.probe === 'tcp' ? `:${target.port}` : ''} · {t('every', { step: target.step, pings: target.pings })}
            {!target.enabled && <> · {t('paused').toUpperCase()}</>}
          </div>
          <h1 className="display">{target.name}</h1>
          <div className="meta host-line">{target.host}</div>
        </div>
        <span className="spacer" />
        <div className="actions">
          <div className="seg pager">
            <button className="seg-btn" disabled={!prev} onClick={() => prev && goTo(prev.id)} title={prev ? `${t('prevTarget')}: ${prev.name}` : t('prevTarget')} aria-label={t('prevTarget')}>
              ‹
            </button>
            <span className="seg-btn pager-pos" title={t('shortcuts')}>
              {idx + 1}/{targets.length}
            </span>
            <button className="seg-btn" disabled={!next} onClick={() => next && goTo(next.id)} title={next ? `${t('nextTarget')}: ${next.name}` : t('nextTarget')} aria-label={t('nextTarget')}>
              ›
            </button>
          </div>
          <button className="btn" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
            {target.enabled ? t('disabled') : t('enabled')}
          </button>
          <button className="btn" onClick={() => onEdit(target)}>
            {t('editTarget')}
          </button>
          <button className="btn danger" onClick={() => setConfirmDel(true)}>
            {t('delete')}
          </button>
        </div>
      </div>

      <div className="stats-caption meta">
        <span>{t('current')}</span>
        <span>{live ? rangeName : `${fmtDateTime(from)} → ${fmtDateTime(to)}`}</span>
      </div>
      <div className="stats-row">
        <Stat className="stat-now" label={last && last.recv > 0 && st !== 'stale' ? t('median') : t('status')} value={nowValue} sub={nowSub} color={nowColor} />
        <div className="stats-range-mobile meta">{live ? rangeName : t('range')}</div>
        <Stat label={t('rangeAvg')} value={fmtMs(stats.median)} />
        <Stat label={t('jitter')} value={fmtMs(stats.jitter)} title={t('jitterHint')} />
        <Stat label={`${t('min')} / ${t('max')}`} value={`${fmtMs(stats.min)} / ${fmtMs(stats.max)}`} />
        <Stat
          label={t('loss')}
          value={fmtLoss(stats.loss)}
          sub={`${stats.recv}/${stats.sent}`}
          color={stats.loss && stats.loss > 0 ? lossColor(stats.loss, dark) : undefined}
        />
        <Stat
          label={t('availability')}
          value={stats.availability === null ? '—' : `${stats.availability.toFixed(stats.availability === 100 ? 0 : 2)}%`}
        />
      </div>

      <div className="win chart-win">
        <div className="win-bar">
          <span className="win-title">SMOKE · {target.name}</span>
          <span className="spacer" />
          {series && (
            <span className="win-meta">
              {series.source} · {fmtDuration(series.bucket, lang)}/pt · {series.points.length}pts
            </span>
          )}
        </div>
        <div className="win-body">
          <div className="chart-toolbar">
            <RangePicker value={presetKey} onChange={setPreset} />
            <span className="spacer" />
            {!live && (
              <button className="btn small" onClick={() => setPreset('3h')}>
                {t('reset')}
              </button>
            )}
            <label className="toggle">
              <input type="checkbox" checked={logScale} onChange={(e) => setLogScale(e.target.checked)} />
              <span>{t('logScale')}</span>
            </label>
          </div>
          {!live && (
            <div className="meta range-label">
              {fmtDateTime(from)} → {fmtDateTime(to)}
            </div>
          )}
          <div className={`chart-wrap${isLoading ? ' loading' : ''}`}>
            {series ? (
              <SmokeChart points={series.points} from={from} to={to} bucket={series.bucket} height={isMobile ? 260 : 380} logScale={logScale} onZoom={zoomTo} />
            ) : (
              <div className="chart-placeholder" style={{ height: isMobile ? 260 : 380 }} />
            )}
            {series && series.points.length === 0 && <div className="chart-empty muted">{t('noData')}</div>}
          </div>
          <div className="legend">
            <span className="meta">{t('lossLegend')}:</span>
            {legend.map((l) => (
              <span key={l.label} className="legend-item">
                <span className="legend-swatch" style={{ background: l.color }} />
                {l.label}
              </span>
            ))}
            <span className="spacer" />
            <span className="meta legend-help" title={t('smokeLegend')}>
              ⓘ {t('zoomHint')}
            </span>
          </div>
        </div>
      </div>

      {confirmDel && (
        <Modal
          title={t('deleteTarget')}
          onClose={() => setConfirmDel(false)}
          footer={
            <>
              <span className="spacer" />
              <button className="btn" onClick={() => setConfirmDel(false)}>
                {t('cancel')}
              </button>
              <button className="btn danger" onClick={() => del.mutate()} disabled={del.isPending}>
                {t('delete')}
              </button>
            </>
          }
        >
          <p>{t('deleteConfirm', { name: target.name })}</p>
          {del.error && <div className="form-error">{(del.error as Error).message}</div>}
        </Modal>
      )}
    </div>
  );
}

function Stat({ label, value, sub, color, title, className = '' }: { label: string; value: string; sub?: string; color?: string; title?: string; className?: string }) {
  return (
    <div className={`stat ${className}`} title={title}>
      <div className="stat-label">{label}</div>
      <div className="stat-value display" style={{ color }}>
        {value}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
