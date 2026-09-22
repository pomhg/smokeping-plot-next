import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Series, TargetView } from '../api';
import { fmtLoss, fmtMs, fmtSince, lossColor } from '../format';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';
import { downFor, statusColor, statusOf } from '../status';
import { SmokeChart } from './SmokeChart';

export type Density = 'card' | 'row';

interface Props {
  target: TargetView;
  series?: Series;
  from: number;
  to: number;
  now: number;
  density?: Density;
  /** Rendered inside the title bar; the sortable wrapper passes a drag handle. */
  handle?: ReactNode;
  style?: CSSProperties;
  className?: string;
  wrapperProps?: HTMLAttributes<HTMLDivElement>;
}

/** The right-hand value cell: median + loss, or a status tag. */
function Reading({ target, now }: { target: TargetView; now: number }) {
  const { t, lang } = useI18n();
  const { resolved } = useTheme();
  const dark = resolved === 'dark';
  const st = statusOf(target, now);
  const last = target.last;
  switch (st) {
    case 'paused':
      return <span className="tag">{t('paused')}</span>;
    case 'pending':
      return <span className="muted">{t('waiting')}</span>;
    case 'stale':
      return (
        <span className="tag muted-tag" title={t('staleHint')}>
          {t('staleFor', { t: fmtSince(now - last!.ts, lang) })}
        </span>
      );
    case 'down': {
      const d = downFor(target, now);
      return (
        <span className="tag danger">
          {d === null ? t('unreachable') : d < 0 ? t('neverUp') : t('downFor', { t: fmtSince(d, lang) })}
        </span>
      );
    }
    default:
      return (
        <>
          <span className="card-val">{fmtMs(last!.median)}</span>
          <span className="card-loss" style={{ color: last!.loss > 0 ? lossColor(last!.loss, dark) : undefined }}>
            {t('loss').toUpperCase()} {fmtLoss(last!.loss)}
          </span>
        </>
      );
  }
}

export const TargetCard = forwardRef<HTMLDivElement, Props>(function TargetCard(
  { target, series, from, to, now, density = 'card', handle, style, className = '', wrapperProps },
  ref,
) {
  const { resolved } = useTheme();
  const dark = resolved === 'dark';
  const st = statusOf(target, now);
  const probe = `${target.probe.toUpperCase()}${target.probe === 'tcp' ? `:${target.port}` : ''}`;
  const led = <span className={`led st-${st}`} style={{ background: statusColor(target, now, dark) }} />;
  const link = { to: `/targets/${target.id}`, draggable: false, onDragStart: (e: React.DragEvent) => e.preventDefault() };

  if (density === 'row') {
    return (
      <div ref={ref} style={style} className={`target-slot row-slot ${className}`} {...wrapperProps}>
        <Link {...link} className={`target-row st-${st}`}>
          {handle}
          {led}
          <span className="row-name">
            <span className="row-title">{target.name}</span>
            <span className="row-host">{target.host}</span>
          </span>
          <span className="row-chart">
            {series ? (
              <SmokeChart points={series.points} from={from} to={to} bucket={series.bucket} height={34} compact bare />
            ) : (
              <span className="chart-placeholder" style={{ height: 34, display: 'block' }} />
            )}
          </span>
          <span className="row-reading">
            <Reading target={target} now={now} />
          </span>
          <span className="row-probe">{probe}</span>
        </Link>
      </div>
    );
  }

  return (
    <div ref={ref} style={style} className={`target-slot ${className}`} {...wrapperProps}>
      <Link {...link} className={`win target-card st-${st}`}>
        <div className="win-bar">
          {handle}
          {led}
          <span className="win-title">{target.name}</span>
          <span className="spacer" />
          <span className="win-meta">{probe}</span>
        </div>
        <div className="win-body">
          <div className="card-row">
            <span className="card-host">{target.host}</span>
            <span className="spacer" />
            <Reading target={target} now={now} />
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
    </div>
  );
});
