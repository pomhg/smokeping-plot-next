import { useEffect } from 'react';
import type { TargetView } from './api';
import { countStatuses } from './status';
import type { Key } from './i18n';

const BASE_TITLE = 'smokeping-plot-next';

function iconSvg(badge: string | null): string {
  const mark =
    '<rect width="32" height="32" rx="7" fill="#1e1e1e"/>' +
    '<path d="M3 21h4v-7h4v4h4V8h4v10h4v-5h4v5h3" fill="none" stroke="#fefefe" stroke-width="3"/>';
  const dot = badge ? `<rect x="18" y="0" width="14" height="14" fill="${badge}" stroke="#1e1e1e" stroke-width="2"/>` : '';
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${mark}${dot}</svg>`)}`;
}

/**
 * Mirror overall health in the tab: "(2) smokeping-plot-next" plus a red /
 * magenta corner on the favicon, so a pinned tab works as a status light.
 */
export function useStatusTitle(targets: TargetView[], now: number, t: (k: Key, v?: Record<string, string | number>) => string) {
  const c = countStatuses(targets, now);
  const problems = c.down + c.degraded + c.stale;
  const badge = c.down > 0 ? '#e40000' : c.degraded > 0 ? '#c400a8' : c.stale > 0 ? '#8a8a8a' : null;
  useEffect(() => {
    document.title = problems > 0 ? `(${problems}) ${t('problemsN', { n: problems })} · ${BASE_TITLE}` : BASE_TITLE;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/svg+xml';
    link.href = iconSvg(badge);
  }, [problems, badge, t]);
}
