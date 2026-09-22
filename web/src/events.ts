import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Sample } from './api';

/**
 * Subscribes to the backend's SSE stream and invalidates the affected
 * queries. Series refetches are debounced so an overview with many targets
 * does not refetch on every single sample.
 */
export function useLiveEvents(): boolean {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/events');
    const scheduleSeriesRefresh = () => {
      if (timer.current !== null) return;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        qc.invalidateQueries({ queryKey: ['series'] });
        qc.invalidateQueries({ queryKey: ['targets'] });
      }, 1500);
    };
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('sample', (ev) => {
      const sm = JSON.parse((ev as MessageEvent).data) as Sample;
      // Patch the cached target list immediately for a snappy status pill.
      qc.setQueryData<import('./api').TargetView[]>(['targets'], (old) =>
        old?.map((t) =>
          t.id !== sm.targetId
            ? t
            : sm.recv > 0
              ? { ...t, last: sm, lastUp: undefined }
              : { ...t, last: sm, lastUp: t.lastUp ?? (t.last && t.last.recv > 0 ? t.last.ts : undefined) },
        ),
      );
      scheduleSeriesRefresh();
    });
    es.addEventListener('targets', () => {
      qc.invalidateQueries({ queryKey: ['targets'] });
      qc.invalidateQueries({ queryKey: ['series'] });
    });
    return () => {
      es.close();
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [qc]);

  return connected;
}
