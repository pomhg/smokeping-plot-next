import { useEffect, useId, useRef, useState } from 'react';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  'aria-label'?: string;
}

/**
 * Custom single-select with the same look as GroupCombobox. Native <select>
 * popups are styled by the OS/browser and clash with the UI.
 */
export function Select<T extends string>({ value, options, onChange, ...aria }: Props<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActiveState] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const activeRef = useRef(active);
  const setActive = (i: number) => {
    activeRef.current = i;
    setActiveState(i);
  };
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDoc = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (i: number) => {
    onChange(options[i].value);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive((activeRef.current + 1) % options.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive(activeRef.current <= 0 ? options.length - 1 : activeRef.current - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (open) pick(activeRef.current);
        else setOpen(true);
        break;
      case 'Escape':
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  return (
    <div className={`select${open ? ' open' : ''}`} ref={wrapRef}>
      <button
        type="button"
        className="select-btn"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={aria['aria-label']}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
      >
        <span>{current?.label ?? value}</span>
        <span className="select-caret">▾</span>
      </button>
      {open && (
        <ul className="combo-list" id={listId} role="listbox">
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`${i === active ? 'active' : ''}${o.value === value ? ' selected' : ''}`}
              onPointerDown={(e) => e.preventDefault()}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(i)}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
