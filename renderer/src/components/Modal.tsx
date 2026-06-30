import type { ComponentChildren } from 'preact';

export function Modal({
  title,
  children,
  width,
  footer,
  onClose,
  className = '',
  headerActions,
  closeOnOverlayClick = true,
}: {
  title: string;
  children: ComponentChildren;
  width?: number;
  footer?: ComponentChildren;
  onClose: () => void;
  className?: string;
  headerActions?: ComponentChildren;
  closeOnOverlayClick?: boolean;
}) {
  return (
    <div class="modal-overlay" onClick={(e) => { if (closeOnOverlayClick && e.currentTarget === e.target) onClose(); }}>
      <div class={`modal ${className}`} style={width ? { width: `${width}px` } : undefined}>
        <div class="modal-header">
          <span class="modal-title">{title}</span>
          <div class="modal-header-actions">
            {headerActions}
            <button class="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
          </div>
        </div>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function AlertModal({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  return (
    <Modal
      title={title}
      width={460}
      onClose={onClose}
      footer={<div class="modal-footer-actions"><button class="btn" onClick={onClose}>OK</button></div>}
    >
      <p style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{message}</p>
    </Modal>
  );
}
