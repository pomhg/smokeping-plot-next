import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Series, TargetView } from '../api';
import { TargetCard, type Density } from './TargetCard';

interface Props {
  target: TargetView;
  series?: Series;
  from: number;
  to: number;
  now: number;
  density: Density;
  disabled?: boolean;
}

export function DragHandle(props: React.HTMLAttributes<HTMLButtonElement> & { ref?: (el: HTMLElement | null) => void }) {
  const { ref, className, ...rest } = props;
  return (
    <button
      type="button"
      className={className ?? 'drag-handle'}
      aria-label="drag to reorder"
      title="拖拽排序 / drag to reorder"
      ref={ref}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      {...rest}
    >
      ⠿
    </button>
  );
}

export function SortableCard({ target, series, from, to, now, density, disabled }: Props) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: target.id,
    disabled,
  });
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };
  return (
    <TargetCard
      ref={setNodeRef}
      style={style}
      className={isDragging ? 'dragging' : ''}
      target={target}
      series={series}
      from={from}
      to={to}
      now={now}
      density={density}
      handle={disabled ? null : <DragHandle ref={setActivatorNodeRef} {...attributes} {...listeners} />}
    />
  );
}
