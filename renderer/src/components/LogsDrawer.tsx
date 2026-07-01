import { useEffect, useImperativeHandle, useRef, useState } from 'preact/hooks';
import { forwardRef } from 'preact/compat';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { ANSI, colorizeLine, detectLogSeverity } from '../terminal/colors';
import type { LogHistoryMode, LogStartOptions } from '../types';

type LogLevel = 'all' | 'stderr' | 'warn' | 'info';
type LogEntry = { text: string; stream?: string };
type LogHistoryRequest = LogStartOptions & { mode: LogHistoryMode; maxLines: number };
const SEARCH_HIGHLIGHT = '\x1b[30;103m';
const DEFAULT_MAX_LOG_LINES = 10000;
const MIN_MAX_LOG_LINES = 500;
const MAX_MAX_LOG_LINES = 100000;
const HISTORY_OPTIONS: Array<{ value: LogHistoryMode; label: string }> = [
  { value: 'live', label: 'Live' },
  { value: 'tail-500', label: '500 lines' },
  { value: 'tail-1000', label: '1k lines' },
  { value: 'tail-5000', label: '5k lines' },
  { value: 'tail-max', label: 'Max lines' },
  { value: 'since-15m', label: '15 min' },
  { value: 'since-1h', label: '1 hour' },
];

export interface LogsDrawerHandle {
  write: (text: string, stream?: string) => void;
  reset: (
    title: string,
    status?: { kind: 'hidden' | 'live' | 'stopped'; text?: string },
    options?: { history?: boolean; historyMode?: LogHistoryMode; onHistoryChange?: (request: LogHistoryRequest) => Promise<void> },
  ) => Promise<void>;
  markStopped: (banner: string) => void;
  markEvent: (label: string) => void;
  setStatus: (kind: 'hidden' | 'live' | 'stopped', text?: string) => void;
}

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

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightSearchMatch(text: string) {
  return Array.from(text).map((char) => `${SEARCH_HIGHLIGHT}${char}${ANSI.reset}`).join('');
}

function readMaxLogLines() {
  const raw = Number(localStorage.getItem('log-max-lines'));
  if (!Number.isFinite(raw)) return DEFAULT_MAX_LOG_LINES;
  return Math.max(MIN_MAX_LOG_LINES, Math.min(MAX_MAX_LOG_LINES, Math.floor(raw)));
}

function historyRequest(mode: LogHistoryMode, maxLines: number): LogHistoryRequest {
  const now = Math.floor(Date.now() / 1000);
  if (mode === 'live') return { mode, maxLines, tail: 0, follow: true };
  if (mode === 'tail-500') return { mode, maxLines, tail: 500, follow: true };
  if (mode === 'tail-1000') return { mode, maxLines, tail: 1000, follow: true };
  if (mode === 'tail-5000') return { mode, maxLines, tail: 5000, follow: true };
  if (mode === 'since-15m') return { mode, maxLines, tail: maxLines, since: now - 15 * 60, follow: true };
  if (mode === 'since-1h') return { mode, maxLines, tail: maxLines, since: now - 60 * 60, follow: true };
  return { mode, maxLines, tail: maxLines, follow: true };
}

function nextDeeperHistory(mode: LogHistoryMode): LogHistoryMode | null {
  if (mode === 'live') return 'tail-500';
  if (mode === 'tail-500') return 'tail-1000';
  if (mode === 'tail-1000') return 'tail-5000';
  if (mode === 'tail-5000') return 'tail-max';
  return null;
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
    const followRef = useRef(true);
    const historyModeRef = useRef<LogHistoryMode>('tail-500');
    const maxLinesRef = useRef(readMaxLogLines());
    const historyLoaderRef = useRef<((request: LogHistoryRequest) => Promise<void>) | null>(null);
    const [title, setTitle] = useState('Logs');
    const [status, setStatusState] = useState<{ kind: 'hidden' | 'live' | 'stopped'; text?: string }>({ kind: 'hidden' });
    const [follow, setFollow] = useState(true);
    const [search, setSearchState] = useState('');
    const [level, setLevelState] = useState<LogLevel>('all');
    const [historyEnabled, setHistoryEnabled] = useState(false);
    const [historyMode, setHistoryModeState] = useState<LogHistoryMode>('tail-500');
    const [historyLoading, setHistoryLoading] = useState(false);
    const [maxLines, setMaxLinesState] = useState(maxLinesRef.current);

    function setFollowValue(value: boolean) {
      followRef.current = value;
      setFollow(value);
    }

    function setSearch(value: string) {
      searchRef.current = value;
      setSearchState(value);
    }

    function setLevel(value: LogLevel) {
      levelRef.current = value;
      setLevelState(value);
    }

    function setHistoryMode(value: LogHistoryMode) {
      historyModeRef.current = value;
      setHistoryModeState(value);
    }

    function refreshMaxLines() {
      const next = readMaxLogLines();
      maxLinesRef.current = next;
      setMaxLinesState(next);
      if (termRef.current) termRef.current.options.scrollback = next;
      return next;
    }

    function applyTerminalTheme() {
      const term = termRef.current;
      if (!term) return;
      term.options.theme = termTheme();
      try { term.refresh(0, term.rows - 1); } catch { /* noop */ }
    }

    function ensureTerm() {
      if (termRef.current || !hostRef.current) return;
      const term = new Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        cursorBlink: false,
        disableStdin: true,
        convertEol: true,
        scrollback: maxLinesRef.current,
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
      const statusBar = document.getElementById('status-bar');
      if (drawer && main) main.style.paddingBottom = `${drawer.offsetHeight + (statusBar?.offsetHeight || 0)}px`;
    }

    function entryLevel(entry: LogEntry): Exclude<LogLevel, 'all'> {
      const severity = detectLogSeverity(entry.text, entry.stream);
      if (severity === 'error') return 'stderr';
      if (severity === 'warn') return 'warn';
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

    function replayEntries(scrollBottom = followRef.current) {
      if (!termRef.current) return;
      termRef.current.clear();
      for (const entry of entriesRef.current) {
        if (!matchesFilters(entry)) continue;
        writeEntry(entry);
      }
      if (scrollBottom) termRef.current.scrollToBottom();
    }

    function clearLogEntries(resetHistoryMode = true) {
      termRef.current?.clear();
      entriesRef.current = [];
      partialRef.current = '';
      if (resetHistoryMode && historyEnabled) setHistoryMode('live');
    }

    async function reloadHistory(mode = historyModeRef.current) {
      const loader = historyLoaderRef.current;
      if (!loader) return;
      const nextMaxLines = refreshMaxLines();
      const request = historyRequest(mode, nextMaxLines);
      setHistoryLoading(true);
      clearLogEntries(false);
      setFollowValue(true);
      try {
        await loader(request);
      } finally {
        setHistoryLoading(false);
      }
    }

    async function chooseHistory(mode: LogHistoryMode) {
      setHistoryMode(mode);
      await reloadHistory(mode);
    }

    async function loadEarlier() {
      const next = nextDeeperHistory(historyModeRef.current);
      if (!next) return;
      setHistoryMode(next);
      await reloadHistory(next);
    }

    function pushEntry(entry: LogEntry) {
      entriesRef.current.push(entry);
      if (entriesRef.current.length > maxLinesRef.current) entriesRef.current.splice(0, entriesRef.current.length - maxLinesRef.current);
      if (matchesFilters(entry)) {
        writeEntry(entry);
      }
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
      applyTerminalTheme();
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
      const observer = new MutationObserver(() => applyTerminalTheme());
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return () => observer.disconnect();
    }, []);

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
      async reset(nextTitle, nextStatus = { kind: 'hidden' }, options = {}) {
        onOpenChange(true);
        setTitle(nextTitle);
        setStatusState(nextStatus);
        endedRef.current = false;
        partialRef.current = '';
        entriesRef.current = [];
        historyLoaderRef.current = options.onHistoryChange || null;
        setHistoryEnabled(!!options.history);
        setHistoryMode(options.historyMode || 'tail-500');
        setHistoryLoading(false);
        refreshMaxLines();
        setFollowValue(true);
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
          pushEntry({ text: line, stream });
        }
        if (followRef.current) termRef.current.scrollToBottom();
      },
      markEvent(label) {
        ensureTerm();
        pushEntry({ text: `--- ${label} ---`, stream: 'stdout' });
        if (followRef.current) termRef.current?.scrollToBottom();
      },
      markStopped(banner) {
        if (endedRef.current) return;
        endedRef.current = true;
        setStatusState({ kind: 'stopped' });
        pushEntry({ text: `--- ${banner} ---`, stream: 'stderr' });
        if (followRef.current) termRef.current?.scrollToBottom();
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
            {historyEnabled && (
              <span class="history-controls">
                <select
                  class="drawer-select history-select"
                  value={historyMode}
                  disabled={historyLoading}
                  title={`Loaded logs are capped at ${maxLines.toLocaleString()} lines`}
                  onChange={(e) => chooseHistory((e.currentTarget as HTMLSelectElement).value as LogHistoryMode)}
                >
                  {HISTORY_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                </select>
                <button
                  class={`btn btn-ghost btn-sm ${historyLoading ? 'loading' : ''}`}
                  disabled={historyLoading || !nextDeeperHistory(historyMode)}
                  onClick={loadEarlier}
                  title={`Load more history, up to ${maxLines.toLocaleString()} lines`}
                >
                  More
                </button>
              </span>
            )}
            <label class="follow"><input type="checkbox" checked={follow} onChange={(e) => setFollowValue((e.currentTarget as HTMLInputElement).checked)} /> Auto-scroll</label>
            <button class="btn btn-ghost" onClick={() => clearLogEntries()}>Clear</button>
            <button class="btn btn-ghost" onClick={() => { api.logs.stop(); api.logs.stopCompose(); onClose(); }}>✕</button>
          </div>
        </div>
        <div class="logs-term-wrap">
          <div id="logs-output" class={`logs-term ${status.kind === 'stopped' ? 'ended' : ''}`} ref={hostRef} />
        </div>
      </div>
    );
  },
);
