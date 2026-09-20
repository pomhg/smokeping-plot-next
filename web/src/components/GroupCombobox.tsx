import { useEffect, useId, useMemo, useRef, useState } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
}

/**
 * Text input with a suggestion list of existing groups. Replaces <datalist>,
 * whose popup behaves differently in every browser (Chrome only opens it on
 * double-click / arrow keys and filters by the current text).
 */
export function GroupCombobox({ value, onChange, options, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActiveState] = useState(-1);
  // mirrored in a ref so a fast ArrowDown+Enter sequence sees the new index
  const activeRef = useRef(-1);
  const setActive = (v: number | ((a: number) => number)) => {
    const next = typeof v === 'function' ? v(activeRef.current) : v;
    activeRef.current = next;
    setActiveState(next);
  };
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    const list = options.filter((o) => !q || o.toLowerCase().includes(q));
    // typing an exact existing name: nothing new to suggest
    return list.length === 1 && list[0].toLowerCase() === q ? [] : list;
  }, [options, value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, [open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setActive(-1);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true);
      e.preventDefault();
      return;
    }
    if (!open || filtered.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a <= 0 ? filtered.length - 1 : a - 1));
    } else if (e.key === 'Enter') {
      const i = activeRef.current >= 0 ? activeRef.current : filtered.length === 1 ? 0 : -1;
      if (i >= 0) {
        e.preventDefault();
        pick(filtered[i]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const showList = open && filtered.length > 0;

  return (
    <div className="combo" ref={wrapRef}>
      <input
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {options.length > 0 && (
        <button
          type="button"
          className="combo-toggle"
          tabIndex={-1}
          aria-label="toggle"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
        >
          ▾
        </button>
      )}
      {showList && (
        <ul className="combo-list" id={listId} role="listbox">
          {filtered.map((o, i) => (
            <li
              key={o}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
              onPointerEnter={() => setActive(i)}
            >
              {o}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
