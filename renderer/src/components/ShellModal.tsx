import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api } from '../api';
import { Modal } from './Modal';

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return {
    background: v('--logs-bg') || '#0b0e13',
    foreground: v('--logs-fg') || v('--text') || '#c9d1d9',
    cursor: v('--blue') || '#388bfd',
    black: v('--logs-black') || '#151b23',
    red: v('--logs-red') || '#ff7b72',
    green: v('--logs-green') || '#7ee787',
    yellow: v('--logs-yellow') || '#f2cc60',
    blue: v('--logs-blue') || '#79c0ff',
    magenta: v('--logs-magenta') || '#d2a8ff',
    cyan: v('--logs-cyan') || '#76e3ea',
    white: v('--logs-fg') || '#c9d1d9',
    brightBlack: v('--logs-muted') || '#6e7681',
    brightRed: v('--logs-red') || '#ff7b72',
    brightGreen: v('--logs-green') || '#7ee787',
    brightYellow: v('--logs-yellow') || '#f2cc60',
    brightBlue: v('--logs-blue') || '#79c0ff',
    brightMagenta: v('--logs-magenta') || '#d2a8ff',
    brightCyan: v('--logs-cyan') || '#76e3ea',
    brightWhite: v('--logs-bright') || '#f0f6fc',
    selectionBackground: 'rgba(56,139,253,0.3)',
  };
}

export function ShellModal({ container, onClose }: { container: { id: string; name: string } | null; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [shell, setShell] = useState('/bin/sh');

  function applyTerminalTheme() {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = termTheme();
    try { term.refresh(0, term.rows - 1); } catch { /* noop */ }
  }

  useEffect(() => {
    if (!container || !hostRef.current) return;
    let dataUnsub: (() => void) | null = null;
    let endUnsub: (() => void) | null = null;
    let inputDisposable: { dispose: () => void } | null = null;
    let cancelled = false;

    const term = termRef.current || new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: termTheme(),
      scrollback: 5000,
    });
    if (!termRef.current) {
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      termRef.current = term;
      fitRef.current = fit;
    }

    async function start() {
      await api.exec.stop();
      applyTerminalTheme();
      term.reset();
      await new Promise((r) => requestAnimationFrame(r));
      try { fitRef.current?.fit(); } catch { /* noop */ }
      term.focus();
      const res = await api.exec.start(container!.id, shell, { cols: term.cols, rows: term.rows });
      if (cancelled) return;
      if (!res.ok) {
        term.write(`\r\n\x1b[31mError: ${res.error}\x1b[0m\r\n`);
        return;
      }
      inputDisposable = term.onData((data) => api.exec.write(data));
      dataUnsub = api.exec.onData((text) => term.write(text));
      endUnsub = api.exec.onEnd((payload) => {
        if (payload?.error) term.write(`\r\n\x1b[31mSession ended: ${payload.error}\x1b[0m\r\n`);
        else term.write('\r\n\x1b[90m--- session ended ---\x1b[0m\r\n');
      });
    }
    start();

    const resize = () => {
      try { fitRef.current?.fit(); } catch { /* noop */ }
      api.exec.resize(term.cols, term.rows);
    };
    window.addEventListener('resize', resize);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', resize);
      dataUnsub?.();
      endUnsub?.();
      inputDisposable?.dispose();
      api.exec.stop();
    };
  }, [container?.id, shell]);

  useEffect(() => {
    const observer = new MutationObserver(() => applyTerminalTheme());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  if (!container) return null;
  return (
    <Modal
      title={`Shell — ${container.name}`}
      className="shell-modal"
      onClose={onClose}
      headerActions={
        <select class="shell-select" value={shell} onChange={(e) => setShell((e.currentTarget as HTMLSelectElement).value)}>
          <option value="/bin/sh">sh</option>
          <option value="/bin/bash">bash</option>
          <option value="/bin/zsh">zsh</option>
        </select>
      }
    >
      <div class="shell-terminal" ref={hostRef} />
    </Modal>
  );
}
