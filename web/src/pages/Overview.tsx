import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api, type TargetView } from '../api';
import { useI18n } from '../i18n';
import { TargetCard, type Density } from '../components/TargetCard';
import { PROBLEM_STATUSES, countStatuses, statusOf, useNow, type Status } from '../status';
import { DragHandle, SortableCard } from '../components/SortableCard';
import { RangePicker } from '../components/RangePicker';
import { CropMarks } from '../components/CropMarks';

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
  onToast?: (msg: string) => void;
}

export function groupsOf(targets: TargetView[]): string[] {
  return Array.from(new Set(targets.map((t) => t.group).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

/** The arrangement as served by the backend: group order + ids per group. */
interface Arrangement {
  groups: string[];
  items: Record<string, number[]>;
}

function derive(targets: TargetView[]): Arrangement {
  const items: Record<string, number[]> = {};
  const groups: string[] = [];
  for (const t of targets) {
    if (!(t.group in items)) {
      items[t.group] = [];
      groups.push(t.group);
    }
    items[t.group].push(t.id);
  }
  return { groups, items };
}

const DROP = 'group:'; // droppable id of a group's card grid
const GSORT = 'gsort:'; // sortable id of a group section
const isGroupId = (id: UniqueIdentifier) => typeof id === 'string' && id.startsWith(GSORT);

export function Overview({ targets, onAdd, onToast }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [rangeKey, setRangeKey] = useState(() => {
    try {
      return localStorage.getItem('spn.overviewRange') ?? '3h';
    } catch {
      return '3h';
    }
  });
  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'problem' | Status | null>(null);
  const [density, setDensity] = useState<Density>(() => {
    try {
      return localStorage.getItem('spn.density') === 'row' ? 'row' : 'card';
    } catch {
      return 'card';
    }
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const now = useNow(15_000);

  useEffect(() => {
    try {
      localStorage.setItem('spn.overviewRange', rangeKey);
      localStorage.setItem('spn.density', density);
    } catch {
      /* ignore */
    }
  }, [rangeKey, density]);

  // "/" focuses search, Esc clears filters
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.closest('input, textarea, [contenteditable], [role=dialog]');
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape' && (el === searchRef.current || !typing)) {
        setQuery('');
        setStatusFilter(null);
        setGroupFilter(null);
        searchRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const range = OVERVIEW_RANGES.find((r) => r.key === rangeKey) ?? OVERVIEW_RANGES[1];
  const to = now;
  const from = to - range.sec;

  const { data: series } = useQuery({
    queryKey: ['series', 'overview', range.key, Math.floor(to / 30)],
    queryFn: () => api.multiSeries(from, to, 140),
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });

  const byId = useMemo(() => new Map(targets.map((x) => [x.id, x])), [targets]);
  const groups = useMemo(() => groupsOf(targets), [targets]);

  // ---------------------------------------------------------------- ordering
  // Local copy of the arrangement, edited live while dragging. Re-derived only
  // when the structure (ids / groups / positions) changes on the server, not
  // on every sample that patches `last`.
  const structure = targets.map((x) => `${x.id}:${x.group}:${x.sortOrder}`).join('|');
  const [arr, setArr] = useState<Arrangement>(() => derive(targets));
  const [active, setActive] = useState<UniqueIdentifier | null>(null);
  const snapshot = useRef<Arrangement | null>(null);
  useEffect(() => {
    if (active === null) setArr(derive(targets));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, active]);

  const onSaveError = (e: Error) => {
    onToast?.(`${t('error')}: ${e.message}`);
    qc.invalidateQueries({ queryKey: ['targets'] });
  };
  const saveItems = useMutation({
    mutationFn: (a: Arrangement) =>
      api.reorderTargets(Object.entries(a.items).flatMap(([group, ids]) => ids.map((id, i) => ({ id, group, sortOrder: i })))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['targets'] }),
    onError: onSaveError,
  });
  const saveGroups = useMutation({
    mutationFn: (groupsInOrder: string[]) => api.setGroupOrder(groupsInOrder),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['targets'] }),
    onError: onSaveError,
  });

  const canSort = query.trim() === '' && groupFilter === null && statusFilter === null;

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** Group that a droppable/sortable/card id belongs to. */
  const groupOf = useCallback((id: UniqueIdentifier, a: Arrangement): string | null => {
    if (typeof id === 'string') {
      if (id.startsWith(DROP)) return id.slice(DROP.length);
      if (id.startsWith(GSORT)) return id.slice(GSORT.length);
      return null;
    }
    for (const [g, ids] of Object.entries(a.items)) if (ids.includes(id)) return g;
    return null;
  }, []);

  const onDragStart = (e: DragStartEvent) => {
    setActive(e.active.id);
    snapshot.current = arr;
  };

  const onDragOver = (e: DragOverEvent) => {
    const { active: a, over } = e;
    if (!over || isGroupId(a.id)) return; // group sorting is resolved on drop
    setArr((cur) => {
      const fromG = groupOf(a.id, cur);
      const toG = groupOf(over.id, cur);
      if (fromG === null || toG === null || fromG === toG) return cur;
      const fromIds = cur.items[fromG].filter((id) => id !== a.id);
      const toIds = [...(cur.items[toG] ?? [])];
      let idx = toIds.indexOf(over.id as number);
      if (idx < 0) idx = toIds.length;
      else if ((a.rect.current.translated?.top ?? 0) > over.rect.top + over.rect.height / 2) idx += 1;
      toIds.splice(idx, 0, a.id as number);
      return { ...cur, items: { ...cur.items, [fromG]: fromIds, [toG]: toIds } };
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active: a, over } = e;
    setActive(null);
    const before = snapshot.current;
    snapshot.current = null;
    if (!over) {
      if (before) setArr(before);
      return;
    }
    if (isGroupId(a.id)) {
      const fromG = groupOf(a.id, arr);
      const toG = groupOf(over.id, arr);
      if (fromG === null || toG === null || fromG === toG) return;
      const next = arrayMove(arr.groups, arr.groups.indexOf(fromG), arr.groups.indexOf(toG));
      setArr({ ...arr, groups: next });
      saveGroups.mutate(next);
      return;
    }
    let next = arr;
    const g = groupOf(a.id, arr);
    const og = groupOf(over.id, arr);
    if (g !== null && g === og && a.id !== over.id) {
      const ids = arr.items[g];
      const oi = ids.indexOf(over.id as number);
      if (oi >= 0) {
        next = { ...arr, items: { ...arr.items, [g]: arrayMove(ids, ids.indexOf(a.id as number), oi) } };
        setArr(next);
      }
    }
    if (JSON.stringify(next.items) !== JSON.stringify(before?.items)) saveItems.mutate(next);
  };

  const onDragCancel = () => {
    if (snapshot.current) setArr(snapshot.current);
    snapshot.current = null;
    setActive(null);
  };

  // ---------------------------------------------------------------- filtering
  const q = query.trim().toLowerCase();
  const matchStatus = (x: TargetView) => {
    if (statusFilter === null) return true;
    const st = statusOf(x, now);
    return statusFilter === 'problem' ? PROBLEM_STATUSES.includes(st) : st === statusFilter;
  };
  const matches = (x: TargetView) =>
    (groupFilter === null || x.group === groupFilter) &&
    matchStatus(x) &&
    (!q || x.name.toLowerCase().includes(q) || x.host.toLowerCase().includes(q) || x.group.toLowerCase().includes(q));

  const sections = useMemo(() => {
    const out: [string, TargetView[]][] = [];
    for (const g of arr.groups) {
      const list = (arr.items[g] ?? []).map((id) => byId.get(id)).filter((x): x is TargetView => !!x && matches(x));
      if (list.length > 0 || active !== null) out.push([g, list]);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arr, byId, q, groupFilter, statusFilter, now, active]);

  if (targets.length === 0) {
    return (
      <div className="empty win">
        <div className="win-bar">
          <span className="win-title">{t('overview')}</span>
        </div>
        <div className="win-body empty-body">
          <h2 className="display">{t('noTargets')}</h2>
          <p className="muted">{t('noTargetsHint')}</p>
          <button className="btn primary" onClick={() => onAdd()}>
            + {t('addTarget')}
          </button>
        </div>
      </div>
    );
  }

  const activeTarget = typeof active === 'number' ? byId.get(active) : undefined;
  const counts = countStatuses(targets, now);
  const problems = counts.down + counts.degraded + counts.stale;
  const filtering = query.trim() !== '' || groupFilter !== null || statusFilter !== null;
  const activeGroup = active !== null && isGroupId(active) ? (active as string).slice(GSORT.length) : null;

  return (
    <div className="overview">
      <StatusBar
        counts={counts}
        total={targets.length}
        problems={problems}
        value={statusFilter}
        onChange={(v) => setStatusFilter((cur) => (cur === v ? null : v))}
      />
      <div className="toolbar">
        <label className="search-wrap">
          <span className="search-prompt">&gt;</span>
          <input
            ref={searchRef}
            className="search"
            type="search"
            placeholder={t('search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query === '' && <kbd className="kbd-hint">/</kbd>}
        </label>
        <RangePicker value={range.key} onChange={setRangeKey} options={OVERVIEW_RANGES} />
        <span className="spacer" />
        <div className="seg" role="radiogroup" aria-label={t('density')}>
          <button role="radio" aria-checked={density === 'card'} className={`seg-btn${density === 'card' ? ' active' : ''}`} onClick={() => setDensity('card')} title={t('densityCard')}>
            ▦<span className="seg-label"> {t('densityCard')}</span>
          </button>
          <button role="radio" aria-checked={density === 'row'} className={`seg-btn${density === 'row' ? ' active' : ''}`} onClick={() => setDensity('row')} title={t('densityRow')}>
            ☰<span className="seg-label"> {t('densityRow')}</span>
          </button>
        </div>
      </div>
      {groups.length > 1 && (
        <div className="seg group-seg">
          <button className={`seg-btn${groupFilter === null ? ' active' : ''}`} onClick={() => setGroupFilter(null)}>
            {t('allGroups')} <span className="count">[{targets.length}]</span>
          </button>
          {groups.map((g) => (
            <button key={g} className={`seg-btn${groupFilter === g ? ' active' : ''}`} onClick={() => setGroupFilter(groupFilter === g ? null : g)}>
              {g} <span className="count">[{targets.filter((x) => x.group === g).length}]</span>
            </button>
          ))}
        </div>
      )}
      {sections.length === 0 && (
        <div className="no-match">
          <p className="muted">{statusFilter === 'problem' ? t('allGood') : t('noMatch')}</p>
          {filtering && (
            <button
              className="btn small"
              onClick={() => {
                setQuery('');
                setGroupFilter(null);
                setStatusFilter(null);
              }}
            >
              {t('clearFilters')}
            </button>
          )}
        </div>
      )}
      {!canSort && sections.length > 0 && <div className="meta sort-hint">{t('sortPaused')}</div>}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <SortableContext items={sections.map(([g]) => GSORT + g)} strategy={verticalListSortingStrategy} disabled={!canSort}>
          {sections.map(([g, list]) => (
            <GroupSection key={g || '__none'} group={g} ids={arr.items[g] ?? []} canSort={canSort} collapsed={activeGroup !== null}>
              {(handle) => (
                <>
                  <div className="group-head">
                    <CropMarks />
                    {handle}
                    <h2 className="display">{g || t('ungrouped')}</h2>
                    <span className="meta">{t('targetsCount', { n: list.length })}</span>
                    <span className="spacer" />
                    <button className="link-btn" onClick={() => onAdd(g)}>
                      [+] {t('addTarget')}
                    </button>
                  </div>
                  {activeGroup === null && (
                    <div className={density === 'row' ? 'rows' : 'grid'}>
                      {list.map((x) => (
                        <SortableCard
                          key={x.id}
                          target={x}
                          series={series?.[String(x.id)]}
                          from={from}
                          to={to}
                          now={now}
                          density={density}
                          disabled={!canSort}
                        />
                      ))}
                      {list.length === 0 && <div className="drop-empty meta">{t('dropHere')}</div>}
                    </div>
                  )}
                </>
              )}
            </GroupSection>
          ))}
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeTarget ? (
            <TargetCard
              className="overlay"
              target={activeTarget}
              series={series?.[String(activeTarget.id)]}
              from={from}
              to={to}
              now={now}
              density={density}
              handle={<span className="drag-handle">⠿</span>}
            />
          ) : activeGroup !== null ? (
            <div className="group-head overlay">
              <CropMarks />
              <span className="drag-handle group-handle">⠿</span>
              <h2 className="display">{activeGroup || t('ungrouped')}</h2>
              <span className="meta">{t('targetsCount', { n: arr.items[activeGroup]?.length ?? 0 })}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

interface GroupSectionProps {
  group: string;
  ids: number[];
  canSort: boolean;
  /** While a group is being dragged, sections collapse to their headers. */
  collapsed: boolean;
  children: (handle: React.ReactNode) => React.ReactNode;
}

function GroupSection({ group, ids, canSort, collapsed, children }: GroupSectionProps) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: DROP + group, disabled: !canSort });
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: GSORT + group,
    disabled: !canSort,
  });
  const style = { transform: CSS.Translate.toString(transform), transition };
  const handle = canSort ? <DragHandle ref={setActivatorNodeRef} className="drag-handle group-handle" {...attributes} {...listeners} /> : null;
  return (
    <section
      ref={(el) => {
        setNodeRef(el);
        setDropRef(el);
      }}
      style={style}
      className={`group${isOver ? ' over' : ''}${isDragging ? ' dragging' : ''}${collapsed ? ' collapsed' : ''}`}
    >
      <SortableContext id={group} items={ids} strategy={rectSortingStrategy} disabled={!canSort}>
        {children(handle)}
      </SortableContext>
    </section>
  );
}

interface StatusBarProps {
  counts: Record<Status, number>;
  total: number;
  problems: number;
  value: 'problem' | Status | null;
  onChange: (v: 'problem' | Status) => void;
}

/** Headline tiles: how many targets are fine / lossy / down. Click to filter. */
function StatusBar({ counts, total, problems, value, onChange }: StatusBarProps) {
  const { t } = useI18n();
  const tiles: { key: 'problem' | Status; label: string; n: number; tone: string; show: boolean }[] = [
    { key: 'up', label: t('stUp'), n: counts.up, tone: 'ok', show: true },
    { key: 'degraded', label: t('stDegraded'), n: counts.degraded, tone: 'warn', show: true },
    { key: 'down', label: t('stDown'), n: counts.down, tone: 'bad', show: true },
    { key: 'stale', label: t('stStale'), n: counts.stale, tone: 'stale', show: counts.stale > 0 },
    { key: 'paused', label: t('stPaused'), n: counts.paused + counts.pending, tone: 'idle', show: counts.paused + counts.pending > 0 },
  ];
  return (
    <div className={`status-bar${problems > 0 ? ' has-problems' : ''}`}>
      <div className="status-summary">
        <span className="meta">{t('targetsCount', { n: total })}</span>
        <span className="status-headline display">{problems > 0 ? t('problemsN', { n: problems }) : t('allGood')}</span>
        {problems > 0 && (
          <button className={`link-btn${value === 'problem' ? ' on' : ''}`} onClick={() => onChange('problem')}>
            {value === 'problem' ? t('showAll') : t('showProblems')}
          </button>
        )}
      </div>
      {tiles
        .filter((x) => x.show)
        .map((x) => (
          <button
            key={x.key}
            className={`status-tile tone-${x.tone}${value === x.key ? ' active' : ''}${x.n === 0 ? ' zero' : ''}`}
            onClick={() => onChange(x.key)}
            aria-pressed={value === x.key}
          >
            <span className="status-n display">{x.n}</span>
            <span className="status-label">
              <span className={`led tone-${x.tone}`} />
              {x.label}
            </span>
          </button>
        ))}
    </div>
  );
}
