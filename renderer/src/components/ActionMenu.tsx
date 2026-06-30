import { useEffect, useRef, useState } from 'preact/hooks';
import { Icons } from './icons';

export interface MenuItem {
  label?: string;
  icon?: keyof typeof Icons;
  danger?: boolean;
  separator?: boolean;
  action?: () => void | Promise<void>;
}

export function ActionMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  return (
    <div class="ctx-menu-wrap">
      <button
        ref={triggerRef}
        class="btn btn-ghost btn-sm ctx-trigger"
        title="Actions"
        onClick={(e) => {
          e.stopPropagation();
          const r = triggerRef.current!.getBoundingClientRect();
          setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
          setOpen((v) => !v);
        }}
      >
        {Icons.menu}
      </button>
      {open && (
        <div class="ctx-menu" style={{ top: `${pos.top}px`, right: `${pos.right}px`, left: 'auto' }}>
          {items.map((item, idx) => item.separator ? (
            <div class="ctx-sep" key={idx} />
          ) : (
            <button
              class={`ctx-item${item.danger ? ' ctx-danger' : ''}`}
              key={`${item.label}-${idx}`}
              onClick={async (e) => {
                e.stopPropagation();
                setOpen(false);
                await item.action?.();
              }}
            >
              {item.icon && <span class="ctx-icon">{Icons[item.icon]}</span>}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
