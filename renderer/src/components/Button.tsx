import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Icons } from './icons';

export function Button({
  label,
  className = 'btn',
  disabled,
  onClick,
  children,
}: {
  label?: string;
  className?: string;
  disabled?: boolean;
  onClick?: () => void | Promise<void>;
  children?: ComponentChildren;
}) {
  const [loading, setLoading] = useState(false);
  const key = label?.toLowerCase() as keyof typeof Icons | undefined;
  const icon = key ? Icons[key] : null;
  return (
    <button
      class={`${className}${loading ? ' loading' : ''}`}
      title={label}
      disabled={disabled || loading}
      onClick={async () => {
        if (!onClick) return;
        setLoading(true);
        try { await onClick(); } finally { setLoading(false); }
      }}
    >
      {children || icon || label}
    </button>
  );
}
