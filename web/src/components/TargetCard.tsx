import { Link } from 'react-router-dom';
import type { Series, TargetView } from '../api';
import { fmtLoss, fmtMs, lossColor } from '../format';
import { useI18n } from '../i18n';
import { SmokeChart } from './SmokeChart';

interface Props {
  target: TargetView;
  series?: Series;
  from: number;
  to: number;
}

export function statusOf(t: TargetView): { color: string; label: string } {
  if (!t.enabled) return { color: 'var(--muted)', label: 'paused' };
  if (!t.last) return { color: 'var(--muted)', label: 'pending' };
  if (t.last.recv === 0) return { color: lossColor(100), label: 'down' };
  return { color: lossColor(t.last.loss), label: 'up' };
}

export function TargetCard({ target, series, from, to }: Props) {
  const { t } = useI18n();
  const st = statusOf(target);
  const last = target.last;
  return (
    <Link to={`/targets/${target.id}`} className={`card target-card${target.enabled ? '' : ' paused'}`}>
      <div className="card-head">
        <span className="status-dot" style={{ background: st.color }} />
        <div className="card-title">
          <div className="name">{target.name}</div>
          <div className="host muted">
            {target.host}
            {target.probe === 'tcp' ? `:${target.port}` : ''}
          </div>
        </div>
        <div className="card-stats">
          {!target.enabled ? (
            <span className="muted">{t('paused')}</span>
          ) : last ? (
            last.recv > 0 ? (
              <>
                <span className="stat-main">{fmtMs(last.median)}</span>
                <span className="stat-sub" style={{ color: last.loss > 0 ? lossColor(last.loss) : undefined }}>
                  {t('loss')} {fmtLoss(last.loss)}
                </span>
              </>
            ) : (
              <span className="stat-main down">{t('unreachable')}</span>
            )
          ) : (
            <span className="muted">{t('waiting')}</span>
          )}
        </div>
      </div>
      <div className="card-chart">
        {series ? (
          <SmokeChart points={series.points} from={from} to={to} bucket={series.bucket} height={90} compact />
        ) : (
          <div className="chart-placeholder" style={{ height: 90 }} />
        )}
      </div>
    </Link>
  );
}
