import { useEffect } from 'preact/hooks';

export function Toast({ message, kind, onClose }: { message: string; kind: 'error' | 'success'; onClose: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onClose, kind === 'success' ? 4000 : 8000);
    return () => window.clearTimeout(t);
  }, [message, kind, onClose]);
  return (
    <div
      class="global-error"
      role="alert"
      style={kind === 'success' ? { borderColor: 'var(--green)', background: 'rgba(46,160,67,0.12)', color: '#7ee787' } : undefined}
    >
      <span class="global-error-text">{message}</span>
      <button class="global-error-close" title="Dismiss" aria-label="Dismiss" onClick={onClose}>×</button>
    </div>
  );
}
