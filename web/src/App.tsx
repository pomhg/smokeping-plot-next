import { useCallback, useEffect, useMemo, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type TargetView } from './api';
import { useLiveEvents } from './events';
import { useI18n } from './i18n';
import { Header } from './components/Header';
import { TargetForm } from './components/TargetForm';
import { Overview, groupsOf } from './pages/Overview';
import { TargetDetail } from './pages/TargetDetail';

type FormState = { mode: 'create'; group?: string } | { mode: 'edit'; target: TargetView } | null;

export default function App() {
  const { t } = useI18n();
  const connected = useLiveEvents();
  const [form, setForm] = useState<FormState>(null);
  const [toast, setToast] = useState<string | null>(null);

  const { data: targets = [], error, isLoading } = useQuery({
    queryKey: ['targets'],
    queryFn: api.targets,
    refetchInterval: connected ? false : 15_000,
  });
  const groups = useMemo(() => groupsOf(targets), [targets]);

  const showToast = useCallback((msg: string) => setToast(msg), []);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(id);
  }, [toast]);

  const closeForm = useCallback(() => setForm(null), []);

  return (
    <div className="app">
      <Header connected={connected} onAdd={() => setForm({ mode: 'create' })} />
      <main className="main">
        {error && (
          <div className="banner error">
            {t('error')}: {(error as Error).message}
          </div>
        )}
        {isLoading ? (
          <div className="muted center">…</div>
        ) : (
          <Routes>
            <Route path="/" element={<Overview targets={targets} onAdd={(group) => setForm({ mode: 'create', group })} />} />
            <Route path="/targets/:id" element={<TargetDetail targets={targets} onEdit={(target) => setForm({ mode: 'edit', target })} onToast={showToast} />} />
          </Routes>
        )}
      </main>
      {form && (
        <TargetForm
          target={form.mode === 'edit' ? form.target : undefined}
          defaultGroup={form.mode === 'create' ? form.group : undefined}
          groups={groups}
          onClose={closeForm}
          onSaved={showToast}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
