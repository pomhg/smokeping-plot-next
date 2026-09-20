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
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { api, type TargetView } from '../api';
import { useI18n } from '../i18n';
import { TargetCard } from '../components/TargetCard';
import { SortableCard } from '../components/SortableCard';
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

/** group name → ordered target ids, as served by the backend */
type Order = Record<string, number[]>;

function deriveOrder(targets: TargetView[]): Order {
  const o: Order = {};
  for (const t of targets) (o[t.group] ??= []).push(t.id);
  return o;
}

function sortGroups(names: string[]): string[] {
  return [...names].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
}

const GROUP_PREFIX = 'group:';

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

  const byId = useMemo(() => new Map(targets.map((x) => [x.id, x])), [targets]);
  const groups = useMemo(() => groupsOf(targets), [targets]);

  // ---------------------------------------------------------------- ordering
  // Local copy of the arrangement, edited live while dragging. Re-derived only
  // when the structure (ids / groups / positions) changes on the server, not on
  // every sample that patches `last`.
  const structure = targets.map((x) => `${x.id}:${x.group}:${x.sortOrder}`).join('|');
  const [order, setOrder] = useState<Order>(() => deriveOrder(targets));
  const [activeId, setActiveId] = useState<number | null>(null);
  const dragSnapshot = useRef<Order | null>(null);
  useEffect(() => {
    if (activeId === null) setOrder(deriveOrder(targets));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, activeId]);

  const save = useMutation({
    mutationFn: (o: Order) =>
      api.reorderTargets(
        Object.entries(o).flatMap(([group, ids]) => ids.map((id, i) => ({ id, group, sortOrder: i }))),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['targets'] }),
    onError: (e: Error) => {
      onToast?.(`${t('error')}: ${e.message}`);
      qc.invalidateQueries({ queryKey: ['targets'] });
    },
  });

  const canSort = query.trim() === '' && groupFilter === null;

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const containerOf = useCallback(
    (id: UniqueIdentifier, o: Order): string | null => {
      if (typeof id === 'string' && id.startsWith(GROUP_PREFIX)) return id.slice(GROUP_PREFIX.length);
      for (const [g, ids] of Object.entries(o)) if (ids.includes(id as number)) return g;
      return null;
    },
    [],
  );

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(e.active.id as number);
    dragSnapshot.current = order;
  };

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    setOrder((o) => {
      const from = containerOf(active.id, o);
      const toG = containerOf(over.id, o);
      if (from === null || toG === null || from === toG) return o;
      const fromIds = o[from].filter((id) => id !== active.id);
      const toIds = [...(o[toG] ?? [])];
      let idx = toIds.indexOf(over.id as number);
      if (idx < 0) idx = toIds.length;
      else {
        // drop after the hovered card when the pointer is past its middle
        const rect = over.rect;
        const y = active.rect.current.translated?.top ?? 0;
        if (y > rect.top + rect.height / 2) idx += 1;
      }
      toIds.splice(idx, 0, active.id as number);
      return { ...o, [from]: fromIds, [toG]: toIds };
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    setActiveId(null);
    let next = order;
    if (over) {
      const g = containerOf(active.id, order);
      const og = containerOf(over.id, order);
      if (g !== null && g === og && active.id !== over.id) {
        const ids = order[g];
        next = { ...order, [g]: arrayMove(ids, ids.indexOf(active.id as number), ids.indexOf(over.id as number)) };
        setOrder(next);
      }
    }
    const before = JSON.stringify(dragSnapshot.current);
    dragSnapshot.current = null;
    if (JSON.stringify(next) !== before) save.mutate(next);
  };

  const onDragCancel = () => {
    if (dragSnapshot.current) setOrder(dragSnapshot.current);
    dragSnapshot.current = null;
    setActiveId(null);
  };

  // ---------------------------------------------------------------- filtering
  const q = query.trim().toLowerCase();
  const matches = (x: TargetView) =>
    (groupFilter === null || x.group === groupFilter) && (!q || x.name.toLowerCase().includes(q) || x.host.toLowerCase().includes(q));

  const sections = useMemo(() => {
    const out: [string, TargetView[]][] = [];
    for (const g of sortGroups(Object.keys(order))) {
      const list = order[g].map((id) => byId.get(id)).filter((x): x is TargetView => !!x && matches(x));
      if (list.length > 0 || activeId !== null) out.push([g, list]);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, byId, q, groupFilter, activeId]);

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

  const activeTarget = activeId !== null ? byId.get(activeId) : undefined;

  return (
    <div className="overview">
      <div className="toolbar">
        <label className="search-wrap">
          <span className="search-prompt">&gt;</span>
          <input className="search" type="search" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <RangePicker value={range.key} onChange={setRangeKey} options={OVERVIEW_RANGES} />
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
      {sections.length === 0 && <p className="muted center">{t('noMatch')}</p>}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        {sections.map(([g, list]) => (
          <GroupSection key={g || '__none'} group={g} ids={order[g] ?? []} canSort={canSort}>
            <div className="group-head">
              <CropMarks />
              <h2 className="display">{g || t('ungrouped')}</h2>
              <span className="meta">{t('targetsCount', { n: list.length })}</span>
              <span className="spacer" />
              <button className="link-btn" onClick={() => onAdd(g)}>
                [+] {t('addTarget')}
              </button>
            </div>
            <div className="grid">
              {list.map((x) => (
                <SortableCard key={x.id} target={x} series={series?.[String(x.id)]} from={from} to={to} disabled={!canSort} />
              ))}
              {list.length === 0 && <div className="drop-empty meta">{t('dropHere')}</div>}
            </div>
          </GroupSection>
        ))}
        <DragOverlay dropAnimation={null}>
          {activeTarget ? (
            <TargetCard className="overlay" target={activeTarget} series={series?.[String(activeTarget.id)]} from={from} to={to} handle={<span className="drag-handle">⠿</span>} />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function GroupSection({ group, ids, canSort, children }: { group: string; ids: number[]; canSort: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: GROUP_PREFIX + group, disabled: !canSort });
  return (
    <section ref={setNodeRef} className={`group${isOver ? ' over' : ''}`}>
      <SortableContext id={group} items={ids} strategy={rectSortingStrategy} disabled={!canSort}>
        {children}
      </SortableContext>
    </section>
  );
}
