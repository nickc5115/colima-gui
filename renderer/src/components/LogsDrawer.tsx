import { useEffect, useImperativeHandle, useRef, useState } from 'preact/hooks';
import { forwardRef } from 'preact/compat';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { ANSI, colorizeLine } from '../terminal/colors';

type LogLevel = 'all' | 'stderr' | 'warn' | 'info';
type LogEntry = { text: string; stream?: string };
const SEARCH_HIGHLIGHT = '\x1b[30;103m';

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

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightSearchMatch(text: string) {
  return Array.from(text).map((char) => `${SEARCH_HIGHLIGHT}${char}${ANSI.reset}`).join('');
}

export const LogsDrawer = forwardRef<LogsDrawerHandle, { open: boolean; onClose: () => void; onOpenChange: (v: boolean) => void }>(
  ({ open, onClose, onOpenChange }, ref) => {
    const hostRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const partialRef = useRef('');
    const entriesRef = useRef<LogEntry[]>([]);
    const searchRef = useRef('');
    const levelRef = useRef<LogLevel>('all');
    const endedRef = useRef(false);
    const [title, setTitle] = useState('Logs');
    const [status, setStatusState] = useState<{ kind: 'hidden' | 'live' | 'stopped'; text?: string }>({ kind: 'hidden' });
    const [follow, setFollow] = useState(true);
    const [search, setSearchState] = useState('');
    const [level, setLevelState] = useState<LogLevel>('all');

    function setSearch(value: string) {
      searchRef.current = value;
      setSearchState(value);
    }

    function setLevel(value: LogLevel) {
      levelRef.current = value;
      setLevelState(value);
    }

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

    function entryLevel(entry: LogEntry): Exclude<LogLevel, 'all'> {
      if (entry.stream === 'stderr' || /\b(error|fatal|fail(?:ed|ure)?|exception|panic)\b/i.test(entry.text)) return 'stderr';
      if (/\b(warn(?:ing)?|deprecated|retry(?:ing)?)\b/i.test(entry.text)) return 'warn';
      return 'info';
    }

    function matchesFilters(entry: LogEntry) {
      const q = searchRef.current.trim().toLowerCase();
      const selected = levelRef.current;
      if (q && !entry.text.toLowerCase().includes(q)) return false;
      if (selected !== 'all' && entryLevel(entry) !== selected) return false;
      return true;
    }

    function renderEntry(entry: LogEntry) {
      const q = searchRef.current.trim();
      if (!q) return colorizeLine(entry.text, entry.stream);
      const parts = entry.text.split(new RegExp(`(${escapeRegex(q)})`, 'ig'));
      return parts.map((part) => (
        part.toLowerCase() === q.toLowerCase()
          ? highlightSearchMatch(part)
          : colorizeLine(part, entry.stream)
      )).join('');
    }

    function writeEntry(entry: LogEntry) {
      termRef.current?.write(`${renderEntry(entry)}\r\n`);
    }

    function replayEntries() {
      if (!termRef.current) return;
      termRef.current.clear();
      for (const entry of entriesRef.current) {
        if (matchesFilters(entry)) writeEntry(entry);
      }
      if (follow) termRef.current.scrollToBottom();
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
      replayEntries();
    }, [search, level]);

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
        entriesRef.current = [];
        setSearch('');
        setLevel('all');
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
        for (const line of parts) {
          const entry = { text: line, stream };
          entriesRef.current.push(entry);
          if (entriesRef.current.length > 10000) entriesRef.current.splice(0, entriesRef.current.length - 10000);
          if (matchesFilters(entry)) writeEntry(entry);
        }
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
            <input
              class="drawer-filter"
              type="search"
              value={search}
              onInput={(e) => setSearch((e.currentTarget as HTMLInputElement).value)}
              placeholder="Search logs"
            />
            <select class="drawer-select" value={level} onChange={(e) => setLevel((e.currentTarget as HTMLSelectElement).value as LogLevel)}>
              <option value="all">All</option>
              <option value="stderr">Errors</option>
              <option value="warn">Warnings</option>
              <option value="info">Info</option>
            </select>
            <label class="follow"><input type="checkbox" checked={follow} onChange={(e) => setFollow((e.currentTarget as HTMLInputElement).checked)} /> Auto-scroll</label>
            <button class="btn btn-ghost" onClick={() => { termRef.current?.clear(); entriesRef.current = []; partialRef.current = ''; }}>Clear</button>
            <button class="btn btn-ghost" onClick={() => { api.logs.stop(); api.logs.stopCompose(); onClose(); }}>✕</button>
          </div>
        </div>
        <div id="logs-output" class={`logs-term ${status.kind === 'stopped' ? 'ended' : ''}`} ref={hostRef} />
      </div>
    );
  },
);
