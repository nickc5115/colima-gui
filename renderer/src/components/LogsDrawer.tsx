import { useEffect, useImperativeHandle, useRef, useState } from 'preact/hooks';
import { forwardRef } from 'preact/compat';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { ANSI, colorizeLine } from '../terminal/colors';

export interface LogsDrawerHandle {
  write: (text: string, stream?: string) => void;
  reset: (title: string, status?: { kind: 'hidden' | 'live' | 'stopped'; text?: string }) => Promise<void>;
  markStopped: (banner: string) => void;
  setStatus: (kind: 'hidden' | 'live' | 'stopped', text?: string) => void;
}

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return {
    background: v('--logs-bg') || '#0b0e13',
    foreground: v('--text') || '#e6edf3',
    cursor: v('--blue') || '#388bfd',
    selectionBackground: 'rgba(56,139,253,0.3)',
  };
}

export const LogsDrawer = forwardRef<LogsDrawerHandle, { open: boolean; onClose: () => void; onOpenChange: (v: boolean) => void }>(
  ({ open, onClose, onOpenChange }, ref) => {
    const hostRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const partialRef = useRef('');
    const endedRef = useRef(false);
    const [title, setTitle] = useState('Logs');
    const [status, setStatusState] = useState<{ kind: 'hidden' | 'live' | 'stopped'; text?: string }>({ kind: 'hidden' });
    const [follow, setFollow] = useState(true);

    function ensureTerm() {
      if (termRef.current || !hostRef.current) return;
      const term = new Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        cursorBlink: false,
        disableStdin: true,
        convertEol: true,
        scrollback: 10000,
        theme: termTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      termRef.current = term;
      fitRef.current = fit;
    }

    function fit() {
      if (!open) return;
      try { fitRef.current?.fit(); } catch { /* noop */ }
      const drawer = document.getElementById('logs-drawer');
      const main = document.getElementById('main');
      if (drawer && main) main.style.paddingBottom = `${drawer.offsetHeight}px`;
    }

    function clampDrawerHeight() {
      const drawer = document.getElementById('logs-drawer');
      if (!drawer || !open) return;
      const min = 120;
      const max = window.innerHeight * 0.85;
      if (drawer.offsetHeight > max || drawer.offsetHeight < min) {
        drawer.style.height = `${Math.max(min, Math.min(max, drawer.offsetHeight))}px`;
      }
    }

    useEffect(() => {
      if (!open) {
        const main = document.getElementById('main');
        if (main) main.style.paddingBottom = '';
        return;
      }
      ensureTerm();
      const drawer = document.getElementById('logs-drawer');
      const saved = parseInt(localStorage.getItem('drawer-height') || '', 10);
      if (drawer && Number.isFinite(saved)) drawer.style.height = `${Math.max(120, Math.min(window.innerHeight * 0.85, saved))}px`;
      requestAnimationFrame(() => { clampDrawerHeight(); fit(); });
    }, [open]);

    useEffect(() => {
      const resize = () => { clampDrawerHeight(); fit(); };
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }, [open]);

    useEffect(() => {
      const handle = document.getElementById('drawer-resize');
      const drawer = document.getElementById('logs-drawer');
      if (!handle || !drawer) return;
      const onDown = (e: MouseEvent) => {
        e.preventDefault();
        document.body.classList.add('drawer-resizing');
        const startY = e.clientY;
        const startH = drawer.offsetHeight;
        const onMove = (ev: MouseEvent) => {
          const dy = startY - ev.clientY;
          drawer.style.height = `${Math.max(120, Math.min(window.innerHeight * 0.85, startH + dy))}px`;
          fit();
        };
        const onUp = () => {
          document.body.classList.remove('drawer-resizing');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          localStorage.setItem('drawer-height', String(drawer.offsetHeight));
          fit();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      };
      const onDbl = () => {
        drawer.style.height = '55vh';
        localStorage.removeItem('drawer-height');
        fit();
      };
      handle.addEventListener('mousedown', onDown);
      handle.addEventListener('dblclick', onDbl);
      return () => {
        handle.removeEventListener('mousedown', onDown);
        handle.removeEventListener('dblclick', onDbl);
      };
    }, [open]);

    useImperativeHandle(ref, () => ({
      async reset(nextTitle, nextStatus = { kind: 'hidden' }) {
        onOpenChange(true);
        setTitle(nextTitle);
        setStatusState(nextStatus);
        endedRef.current = false;
        partialRef.current = '';
        ensureTerm();
        termRef.current?.reset();
        termRef.current!.options.theme = termTheme();
        await new Promise((r) => requestAnimationFrame(r));
        fit();
      },
      write(text, stream) {
        ensureTerm();
        if (!termRef.current) return;
        const combined = partialRef.current + text;
        const parts = combined.split('\n');
        partialRef.current = parts.pop() || '';
        for (const line of parts) termRef.current.write(`${colorizeLine(line, stream)}\r\n`);
        if (follow) termRef.current.scrollToBottom();
      },
      markStopped(banner) {
        if (endedRef.current) return;
        endedRef.current = true;
        setStatusState({ kind: 'stopped' });
        termRef.current?.write(`\r\n${ANSI.boldRed}--- ${banner} ---${ANSI.reset}\r\n`);
        if (follow) termRef.current?.scrollToBottom();
      },
      setStatus(kind, text) {
        setStatusState({ kind, text });
      },
    }));

    return (
      <div id="logs-drawer" class={`drawer ${open ? '' : 'hidden'}`}>
        <div id="drawer-resize" class="drawer-resize-handle" />
        <div class="drawer-header">
          <span class="drawer-title-wrap">
            <span id="logs-title">{title}</span>
            {status.kind !== 'hidden' && <span class={`logs-status ${status.kind}`}>{status.kind === 'live' ? '●' : '■'} {status.text || status.kind}</span>}
          </span>
          <div class="drawer-controls">
            <label class="follow"><input type="checkbox" checked={follow} onChange={(e) => setFollow((e.currentTarget as HTMLInputElement).checked)} /> Auto-scroll</label>
            <button class="btn btn-ghost" onClick={() => { termRef.current?.clear(); partialRef.current = ''; }}>Clear</button>
            <button class="btn btn-ghost" onClick={() => { api.logs.stop(); api.logs.stopCompose(); onClose(); }}>✕</button>
          </div>
        </div>
        <div id="logs-output" class={`logs-term ${status.kind === 'stopped' ? 'ended' : ''}`} ref={hostRef} />
      </div>
    );
  },
);
