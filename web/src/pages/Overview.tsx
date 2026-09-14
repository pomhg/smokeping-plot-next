import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type TargetView } from '../api';
import { useI18n } from '../i18n';
import { TargetCard } from '../components/TargetCard';
import { RangePicker } from '../components/RangePicker';

const OVERVIEW_RANGES = [
  { key: '1h', sec: 3600 },
  { key: '3h', sec: 3 * 3600 },
  { key: '12h', sec: 12 * 3600 },
  { key: '1d', sec: 86400 },
  { key: '7d', sec: 7 * 86400 },
];

interface Props {
  targets: TargetView[];
  onAdd: (group?: string) => void;
}

export function groupsOf(targets: TargetView[]): string[] {
  return Array.from(new Set(targets.map((t) => t.group).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

export function Overview({ targets, onAdd }: Props) {
  const { t } = useI18n();
  const [rangeKey, setRangeKey] = useState(() => {
    try {
      return localStorage.getItem('spn.overviewRange') ?? '3h';
    } catch {
      return '3h';
    }
  });
  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('spn.overviewRange', rangeKey);
    } catch {
      /* ignore */
    }
  }, [rangeKey]);

  const range = OVERVIEW_RANGES.find((r) => r.key === rangeKey) ?? OVERVIEW_RANGES[1];
  const to = now;
  const from = to - range.sec;

  const { data: series } = useQuery({
    queryKey: ['series', 'overview', range.key, Math.floor(to / 30)],
    queryFn: () => api.multiSeries(from, to, 140),
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });

  const groups = useMemo(() => groupsOf(targets), [targets]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return targets.filter(
      (x) => (groupFilter === null || x.group === groupFilter) && (!q || x.name.toLowerCase().includes(q) || x.host.toLowerCase().includes(q)),
    );
  }, [targets, query, groupFilter]);
  const sections = useMemo(() => {
    const m = new Map<string, TargetView[]>();
    for (const x of filtered) {
      const g = x.group || '';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(x);
    }
    return Array.from(m.entries()).sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [filtered]);

  if (targets.length === 0) {
    return (
      <div className="empty">
        <div className="empty-art">📡</div>
        <h2>{t('noTargets')}</h2>
        <p className="muted">{t('noTargetsHint')}</p>
        <button className="btn primary" onClick={() => onAdd()}>
          + {t('addTarget')}
        </button>
      </div>
    );
  }

  return (
    <div className="overview">
      <div className="toolbar">
        <input className="search" type="search" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <RangePicker value={range.key} onChange={setRangeKey} options={OVERVIEW_RANGES} />
      </div>
      {groups.length > 1 && (
        <div className="chips group-chips">
          <button className={`chip${groupFilter === null ? ' active' : ''}`} onClick={() => setGroupFilter(null)}>
            {t('allGroups')} <span className="count">{targets.length}</span>
          </button>
          {groups.map((g) => (
            <button key={g} className={`chip${groupFilter === g ? ' active' : ''}`} onClick={() => setGroupFilter(groupFilter === g ? null : g)}>
              {g} <span className="count">{targets.filter((x) => x.group === g).length}</span>
            </button>
          ))}
        </div>
      )}
      {sections.length === 0 && <p className="muted center">{t('noMatch')}</p>}
      {sections.map(([g, list]) => (
        <section key={g || '__none'} className="group">
          <div className="group-head">
            <h2>{g || t('ungrouped')}</h2>
            <span className="muted">{t('targetsCount', { n: list.length })}</span>
            <span className="spacer" />
            <button className="link-btn" onClick={() => onAdd(g)}>
              + {t('addTarget')}
            </button>
          </div>
          <div className="grid">
            {list.map((x) => (
              <TargetCard key={x.id} target={x} series={series?.[String(x.id)]} from={from} to={to} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
