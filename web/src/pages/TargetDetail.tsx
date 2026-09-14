import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type TargetView } from '../api';
import { useI18n } from '../i18n';
import { fmtDateTime, fmtDuration, fmtLoss, fmtMs, lossColor, lossLegend } from '../format';
import { SmokeChart } from '../components/SmokeChart';
import { RANGES, RangePicker } from '../components/RangePicker';
import { Modal } from '../components/Modal';
import { statusOf } from '../components/TargetCard';

interface Props {
  targets: TargetView[];
  onEdit: (t: TargetView) => void;
  onToast: (msg: string) => void;
}

export function TargetDetail({ targets, onEdit, onToast }: Props) {
  const { id } = useParams();
  const target = targets.find((x) => String(x.id) === id);
  const { t, lang } = useI18n();
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
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const iv = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => window.clearInterval(iv);
  }, []);
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
    for (const p of pts) {
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
      sent,
      recv,
    };
  }, [series]);

  if (!target) {
    return (
      <div className="empty">
        <h2>{t('notFound')}</h2>
        <Link to="/" className="btn">
          ← {t('back')}
        </Link>
      </div>
    );
  }

  const st = statusOf(target);
  const last = target.last;
  const ageSec = last ? Math.max(0, now - last.ts) : null;
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

  return (
    <div className="detail">
      <div className="detail-head">
        <Link to="/" className="icon-btn back" aria-label={t('back')}>
          ←
        </Link>
        <span className="status-dot lg" style={{ background: st.color }} />
        <div className="detail-title">
          <h1>{target.name}</h1>
          <div className="muted sub">
            {target.host}
            {target.probe === 'tcp' ? `:${target.port}` : ''} · {target.probe.toUpperCase()} · {t('every', { step: target.step, pings: target.pings })}
            {target.group && <> · {target.group}</>}
            {!target.enabled && <> · {t('paused')}</>}
            {ageSec !== null && (
              <>
                {' '}
                · {t('lastUpdate')}: {ageSec < 5 ? t('justNow') : t('ago', { t: fmtDuration(ageSec, lang) })}
              </>
            )}
          </div>
        </div>
        <span className="spacer" />
        <div className="actions">
          <button className="btn" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
            {target.enabled ? '⏸ ' + t('disabled') : '▶ ' + t('enabled')}
          </button>
          <button className="btn" onClick={() => onEdit(target)}>
            ✎ {t('editTarget')}
          </button>
          <button className="btn danger" onClick={() => setConfirmDel(true)}>
            🗑 {t('delete')}
          </button>
        </div>
      </div>

      <div className="stats-row">
        <Stat label={t('median')} value={last && last.recv > 0 ? fmtMs(last.median) : last ? t('unreachable') : '—'} color={last && last.recv === 0 ? lossColor(100) : undefined} />
        <Stat label={t('loss')} value={last ? fmtLoss(last.loss) : '—'} color={last && last.loss > 0 ? lossColor(last.loss) : undefined} />
        <Stat label={`${t('avg')} ${t('median')}`} value={fmtMs(stats.median)} sub={t('range')} />
        <Stat label={`${t('min')} / ${t('max')}`} value={`${fmtMs(stats.min)} / ${fmtMs(stats.max)}`} sub={t('range')} />
        <Stat label={`${t('loss')}`} value={fmtLoss(stats.loss)} sub={`${t('range')} · ${stats.recv}/${stats.sent}`} color={stats.loss && stats.loss > 0 ? lossColor(stats.loss) : undefined} />
        <Stat label={t('availability')} value={stats.availability === null ? '—' : `${stats.availability.toFixed(stats.availability === 100 ? 0 : 2)}%`} sub={t('range')} />
      </div>

      <div className="card chart-card">
        <div className="chart-toolbar">
          <RangePicker value={presetKey} onChange={setPreset} />
          <span className="spacer" />
          {!live && (
            <button className="btn small" onClick={() => setPreset('3h')}>
              ⟲ {t('reset')}
            </button>
          )}
          <label className="toggle">
            <input type="checkbox" checked={logScale} onChange={(e) => setLogScale(e.target.checked)} />
            <span>{t('logScale')}</span>
          </label>
        </div>
        {!live && (
          <div className="muted range-label">
            {fmtDateTime(from)} → {fmtDateTime(to)}
          </div>
        )}
        <div className={`chart-wrap${isLoading ? ' loading' : ''}`}>
          {series ? (
            <SmokeChart points={series.points} from={from} to={to} bucket={series.bucket} height={isMobile ? 260 : 360} logScale={logScale} onZoom={zoomTo} />
          ) : (
            <div className="chart-placeholder" style={{ height: isMobile ? 260 : 360 }} />
          )}
          {series && series.points.length === 0 && <div className="chart-empty muted">{t('noData')}</div>}
        </div>
        <div className="legend">
          <span className="legend-title">{t('lossLegend')}:</span>
          {lossLegend.map((l) => (
            <span key={l.label} className="legend-item">
              <span className="legend-swatch" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
          <span className="legend-smoke muted">{t('smokeLegend')}</span>
          {series && (
            <span className="muted legend-meta">
              {series.source} · {fmtDuration(series.bucket, lang)}/pt · {series.points.length} pts
            </span>
          )}
        </div>
        <div className="muted hint">{t('zoomHint')}</div>
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

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="stat">
      <div className="stat-label muted">{label}</div>
      <div className="stat-value" style={{ color }}>
        {value}
      </div>
      {sub && <div className="stat-sub muted">{sub}</div>}
    </div>
  );
}
