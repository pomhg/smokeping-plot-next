import { Link } from 'react-router-dom';
import type { Series, TargetView } from '../api';
import { fmtLoss, fmtMs, lossColor } from '../format';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';
import { SmokeChart } from './SmokeChart';

interface Props {
  target: TargetView;
  series?: Series;
  from: number;
  to: number;
}

export type Status = 'up' | 'degraded' | 'down' | 'pending' | 'paused';

export function statusOf(t: TargetView): Status {
  if (!t.enabled) return 'paused';
  if (!t.last) return 'pending';
  if (t.last.recv === 0) return 'down';
  if (t.last.loss > 0) return 'degraded';
  return 'up';
}

export function statusColor(t: TargetView, dark: boolean): string {
  const st = statusOf(t);
  if (st === 'paused' || st === 'pending') return 'transparent';
  if (st === 'down') return lossColor(100, dark);
  return lossColor(t.last!.loss, dark);
}

export function TargetCard({ target, series, from, to }: Props) {
  const { t } = useI18n();
  const { resolved } = useTheme();
  const dark = resolved === 'dark';
  const st = statusOf(target);
  const last = target.last;
  return (
    <Link to={`/targets/${target.id}`} className={`win target-card st-${st}`}>
      <div className="win-bar">
        <span className={`led st-${st}`} style={{ background: statusColor(target, dark) }} />
        <span className="win-title">{target.name}</span>
        <span className="spacer" />
        <span className="win-meta">
          {target.probe.toUpperCase()}
          {target.probe === 'tcp' ? `:${target.port}` : ''}
        </span>
      </div>
      <div className="win-body">
        <div className="card-row">
          <span className="card-host">{target.host}</span>
          <span className="spacer" />
          {st === 'paused' ? (
            <span className="tag">{t('paused')}</span>
          ) : st === 'pending' ? (
            <span className="muted">{t('waiting')}</span>
          ) : st === 'down' ? (
            <span className="tag danger">{t('unreachable')}</span>
          ) : (
            <>
              <span className="card-val">{fmtMs(last!.median)}</span>
              <span className="card-loss" style={{ color: last!.loss > 0 ? lossColor(last!.loss, dark) : undefined }}>
                {t('loss').toUpperCase()} {fmtLoss(last!.loss)}
              </span>
            </>
          )}
        </div>
        <div className="card-chart">
          {series ? (
            <SmokeChart points={series.points} from={from} to={to} bucket={series.bucket} height={88} compact />
          ) : (
            <div className="chart-placeholder" style={{ height: 88 }} />
          )}
        </div>
      </div>
    </Link>
  );
}
