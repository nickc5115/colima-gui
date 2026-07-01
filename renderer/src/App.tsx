import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  ActionName,
  ColimaProfile,
  ComposeLogEnd,
  ComposeServiceRef,
  ContainerSummary,
  DockerEvent,
  ImageSummary,
  LogStartOptions,
  NetworkSummary,
  StatsSnapshot,
  Tab,
  ThemePref,
  VolumeSummary,
} from './types';
import { api } from './api';
import { humanSize, formatDate } from './utils/format';
import { groupComposeProjects } from './utils/compose';
import { RefreshCoordinator } from './utils/refreshCoordinator';
import { nextLogStatus } from './utils/logStatus';
import { DataTable, type Column } from './components/DataTable';
import { Sidebar } from './components/Sidebar';
import { Button } from './components/Button';
import { ActionMenu } from './components/ActionMenu';
import { AlertModal, Modal } from './components/Modal';
import { Toast } from './components/Toast';
import { LogsDrawer, type LogsDrawerHandle } from './components/LogsDrawer';
import { ShellModal } from './components/ShellModal';

const ACTION_VERB: Record<ActionName, string> = { start: 'starting…', stop: 'stopping…', restart: 'restarting…' };
const DEFAULT_LOG_HISTORY: LogStartOptions = { tail: 500, follow: true };

function systemTheme(): 'dark' | 'light' {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(pref: ThemePref) {
  document.documentElement.setAttribute('data-theme', pref === 'system' ? systemTheme() : pref);
}

function statMarkup(stats?: StatsSnapshot, loading = false) {
  if (loading) return <span class="muted">—</span>;
  if (!stats) return <span class="muted">—</span>;
  const normalize = localStorage.getItem('cpu-display') !== 'raw';
  const cpu = normalize ? stats.cpu / (stats.cpuCount || 1) : stats.cpu;
  return (
    <>
      <div class="stat-row"><span class="stat-cpu">{stats.warming ? '…' : `${cpu.toFixed(1)}%`}</span></div>
      <div class="stat-row"><span class="stat-mem">{humanSize(stats.memUsage)} / {humanSize(stats.memLimit)}</span></div>
    </>
  );
}

function statusTone(text: string) {
  const value = text.toLowerCase();
  if (/(running|healthy|live|up)/.test(value)) return 'running';
  if (/(starting|restarting|stopping|created|paused)/.test(value)) return 'pending';
  if (/(exited|dead|error|failed|unhealthy|stopped)/.test(value)) return 'stopped';
  return 'neutral';
}

function StatusPill({ text, tone }: { text: string; tone?: 'running' | 'pending' | 'stopped' | 'neutral' }) {
  const resolved = tone || statusTone(text);
  return <span class={`status-pill status-pill-${resolved}`}><span class="status-dot" />{text || 'unknown'}</span>;
}

function EngineStatusBar({
  profile,
  running,
  busy,
  containers,
  stats,
  theme,
  onStart,
  onStop,
  onLogs,
  onTheme,
}: {
  profile?: ColimaProfile;
  running: boolean;
  busy: string | null;
  containers: ContainerSummary[];
  stats: Record<string, StatsSnapshot>;
  theme: ThemePref;
  onStart: () => void;
  onStop: () => void;
  onLogs: () => void;
  onTheme: (theme: ThemePref) => void;
}) {
  const statList = Object.values(stats).filter((s) => !s.warming);
  const normalize = localStorage.getItem('cpu-display') !== 'raw';
  const cpu = statList.reduce((sum, s) => sum + (normalize ? s.cpu / (s.cpuCount || 1) : s.cpu), 0);
  const memUsage = statList.reduce((sum, s) => sum + s.memUsage, 0);
  const memLimit = profile?.memory || statList.reduce((max, s) => Math.max(max, s.memLimit || 0), 0);
  const runningContainers = containers.filter((c) => c.state === 'running').length;
  const status = busy || (running ? 'Engine running' : 'Engine stopped');
  const tone = busy ? 'pending' : running ? 'running' : 'stopped';

  return (
    <footer id="status-bar">
      <div class="status-bar-left">
        <span class={`engine-mark engine-${tone}`}>
          <span class="engine-mark-dot" />
        </span>
        <span class={`engine-label engine-label-${tone}`}>{status}</span>
        <span class="status-divider" />
        <span class="status-bar-item">Profile <strong>{profile?.name || 'default'}</strong></span>
        <span class="status-bar-item">Runtime <strong>{profile?.runtime || 'docker'}</strong></span>
      </div>
      <div class="status-bar-center">
        <span class="status-bar-item">Containers <strong>{runningContainers}/{containers.length}</strong></span>
        <span class="status-bar-item">CPU <strong>{running && statList.length ? `${cpu.toFixed(1)}%` : '—'}</strong></span>
        <span class="status-bar-item">RAM <strong>{running && memLimit ? `${humanSize(memUsage)} / ${humanSize(memLimit)}` : profile?.memory ? humanSize(profile.memory) : '—'}</strong></span>
        {profile?.disk && <span class="status-bar-item">Disk <strong>{humanSize(profile.disk)}</strong></span>}
      </div>
      <div class="status-bar-actions">
        {running
          ? <button class="status-action danger" disabled={!!busy} onClick={onStop}>Stop</button>
          : <button class="status-action success" disabled={!!busy} onClick={onStart}>Start</button>}
        <ActionMenu items={[
          { label: 'Start engine', icon: 'start', disabled: running || !!busy, action: onStart },
          { label: 'Stop engine', icon: 'stop', danger: true, disabled: !running || !!busy, action: onStop },
          { separator: true },
          { label: 'View startup logs', icon: 'logs', action: onLogs },
          { separator: true },
          { label: 'System theme', selected: theme === 'system', action: () => onTheme('system') },
          { label: 'Light theme', selected: theme === 'light', action: () => onTheme('light') },
          { label: 'Dark theme', selected: theme === 'dark', action: () => onTheme('dark') },
        ]} />
      </div>
    </footer>
  );
}

function buildRunCommand(info: any) {
  const cfg = info.Config || {};
  const hc = info.HostConfig || {};
  const parts = ['docker run'];
  if (cfg.Hostname) parts.push(`--hostname ${cfg.Hostname}`);
  const name = (info.Name || '').replace(/^\//, '');
  if (name) parts.push(`--name ${name}`);
  if (hc.RestartPolicy?.Name && hc.RestartPolicy.Name !== 'no') parts.push(`--restart ${hc.RestartPolicy.Name}${hc.RestartPolicy.MaximumRetryCount ? `:${hc.RestartPolicy.MaximumRetryCount}` : ''}`);
  for (const [containerPort, bindings] of Object.entries(hc.PortBindings || {}) as any) {
    for (const b of bindings || []) {
      const hp = b.HostPort || '';
      const hip = b.HostIp && b.HostIp !== '0.0.0.0' ? `${b.HostIp}:` : '';
      parts.push(`-p ${hip}${hp}:${String(containerPort).replace('/tcp', '')}`);
    }
  }
  for (const env of cfg.Env || []) parts.push(`-e "${env}"`);
  for (const m of hc.Binds || []) parts.push(`-v ${m}`);
  for (const n of Object.keys(info.NetworkSettings?.Networks || {}).filter((n) => n !== 'bridge')) parts.push(`--network ${n}`);
  if (hc.Memory > 0) parts.push(`-m ${Math.round(hc.Memory / 1024 / 1024)}m`);
  if (hc.NanoCpus > 0) parts.push(`--cpus ${(hc.NanoCpus / 1e9).toFixed(2)}`);
  if (cfg.WorkingDir) parts.push(`-w ${cfg.WorkingDir}`);
  if (cfg.User) parts.push(`-u ${cfg.User}`);
  for (const [k, v] of Object.entries(cfg.Labels || {})) if (!String(k).startsWith('com.docker.')) parts.push(`-l "${k}=${v}"`);
  parts.push(cfg.Image || '');
  if (cfg.Cmd?.length) parts.push(cfg.Cmd.join(' '));
  return parts.join(' \\\n  ');
}

export function App() {
  const [tab, setTab] = useState<Tab>('containers');
  const [theme, setTheme] = useState<ThemePref>((localStorage.getItem('theme') as ThemePref) || 'system');
  const [sidebarExpanded, setSidebarExpanded] = useState(localStorage.getItem('sidebar-expanded') === '1');
  const [profiles, setProfiles] = useState<ColimaProfile[]>([]);
  const [profile, setProfile] = useState('default');
  const [colimaBusy, setColimaBusy] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState('');
  const [containers, setContainers] = useState<ContainerSummary[]>([]);
  const [images, setImages] = useState<ImageSummary[]>([]);
  const [volumes, setVolumes] = useState<VolumeSummary[]>([]);
  const [networks, setNetworks] = useState<NetworkSummary[]>([]);
  const [stats, setStats] = useState<Record<string, StatsSnapshot>>({});
  const [pending, setPending] = useState<Map<string, string>>(new Map());
  const [toast, setToast] = useState<{ message: string; kind: 'error' | 'success' } | null>(null);
  const [alert, setAlert] = useState<{ title: string; message: string } | null>(null);
  const [command, setCommand] = useState<{ title: string; text: string } | null>(null);
  const [inspector, setInspector] = useState<{ title: string; info: any } | null>(null);
  const [shell, setShell] = useState<{ id: string; name: string } | null>(null);
  const [prune, setPrune] = useState<{ title: string; summary: string; rows: string[][]; total?: string; confirm?: string; onConfirm?: () => Promise<void> } | null>(null);
  const [config, setConfig] = useState<{ raw: string; parsed: any; path: string; advanced: boolean; error?: string } | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [composeCollapsed, setComposeCollapsed] = useState<Set<string>>(new Set(JSON.parse(localStorage.getItem('compose-collapsed') || '[]')));
  const logsRef = useRef<LogsDrawerHandle>(null);
  const activeLogId = useRef<string | null>(null);
  const composeLive = useRef<Map<string, ComposeServiceRef>>(new Map());
  const refreshFn = useRef<() => Promise<void>>(async () => {});
  const refreshCoordinator = useRef(new RefreshCoordinator(() => refreshFn.current()));
  const eventUnsub = useRef<null | (() => void)>(null);
  const eventEndUnsub = useRef<null | (() => void)>(null);
  const logUnsubs = useRef<Array<() => void>>([]);
  const statsTimers = useRef<number[]>([]);

  const showError = useCallback((message: string) => setToast({ message, kind: 'error' }), []);
  const flashSuccess = useCallback((message: string) => setToast({ message, kind: 'success' }), []);
  const showAlert = useCallback((message: string, title = 'Error') => setAlert({ message, title }), []);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const refreshColima = useCallback(async () => {
    const res = await api.colima.list();
    if (!res.ok) {
      setRunning(false);
      showError(res.error);
      return false;
    }
    const names = res.profiles.map((p) => p.name);
    setProfiles(res.profiles);
    const selected = names.includes(profile) ? profile : (names[0] || 'default');
    if (selected !== profile) setProfile(selected);
    const p = res.profiles.find((x) => x.name === selected) || res.profiles[0];
    const isRunning = String(p?.status || '').toLowerCase() === 'running';
    setRunning(isRunning);
    return isRunning;
  }, [profile, showError]);

  const clearData = useCallback(() => {
    setContainers([]);
    setImages([]);
    setVolumes([]);
    setNetworks([]);
    setStats({});
    statsTimers.current.forEach((t) => clearInterval(t));
    statsTimers.current = [];
  }, []);

  const refreshStats = useCallback(async (ids: string[]) => {
    statsTimers.current.forEach((t) => clearInterval(t));
    statsTimers.current = [];
    const load = async (id: string) => {
      const res = await api.container.stats(id);
      if (res.ok) setStats((s) => ({ ...s, [id]: res }));
    };
    ids.forEach((id) => {
      load(id);
      statsTimers.current.push(window.setInterval(() => load(id), (parseInt(localStorage.getItem('stats-interval') || '5', 10) || 5) * 1000));
    });
  }, []);

  const refreshActive = useCallback(async () => {
    const isRunning = await refreshColima();
    if (!isRunning) { clearData(); return; }
    if (tab === 'containers' || tab === 'compose') {
      const res = await api.docker.containers();
      if (!res.ok) { showError(res.error); return; }
      setContainers(res.containers);
      if (tab === 'containers') refreshStats(res.containers.filter((c) => c.state === 'running').map((c) => c.id));
    } else if (tab === 'images') {
      const res = await api.docker.images();
      if (!res.ok) { showError(res.error); return; }
      setImages(res.images);
    } else if (tab === 'volumes') {
      const res = await api.volume.list();
      if (!res.ok) { showError(res.error); return; }
      setVolumes(res.volumes);
    } else if (tab === 'networks') {
      const res = await api.network.list();
      if (!res.ok) { showError(res.error); return; }
      setNetworks(res.networks);
    }
  }, [clearData, refreshColima, refreshStats, showError, tab]);
  refreshFn.current = refreshActive;

  const requestRefresh = useCallback(() => refreshCoordinator.current.request(), []);

  useEffect(() => {
    requestRefresh();
  }, [tab, requestRefresh]);

  useEffect(() => {
    const t = window.setInterval(() => refreshColima(), 15000);
    return () => window.clearInterval(t);
  }, [refreshColima]);

  useEffect(() => {
    if (!running) {
      eventUnsub.current?.();
      eventEndUnsub.current?.();
      eventUnsub.current = null;
      eventEndUnsub.current = null;
      api.events.stop();
      return;
    }
    if (eventUnsub.current) return;
    eventUnsub.current = api.events.onData((evt: DockerEvent) => {
      if (evt.Type === 'container' || evt.Type === 'image') requestRefresh();
      if (evt.Type !== 'container') return;
      const evtId = evt.id || evt.Actor?.ID || '';
      const action = evt.Action || evt.status || '';
      if (activeLogId.current && evtId.slice(0, 12) === activeLogId.current.slice(0, 12) && /^(start|restart|health_status)/.test(action)) {
        logsRef.current?.markEvent(action.replace(/_/g, ' '));
      }
      if (/^(die|stop|kill)/.test(action)) {
        if (activeLogId.current && evtId.slice(0, 12) === activeLogId.current.slice(0, 12)) {
          nextLogStatus('live', { stopEvent: true });
          logsRef.current?.markStopped('container stopped - showing final logs');
        }
        for (const ref of composeLive.current.values()) {
          if (evtId.slice(0, 12) === ref.id.slice(0, 12)) handleComposeEnd({ ...ref, running: false });
        }
      }
    });
    eventEndUnsub.current = api.events.onEnd(() => {
      // Keep the renderer listeners installed; only restart the main-process
      // Docker stream. Otherwise a reconnect would silently lose refresh events.
      window.setTimeout(() => { if (running) api.events.start(); }, 3000);
    });
    api.events.start();
  }, [running, requestRefresh]);

  useEffect(() => () => {
    statsTimers.current.forEach((t) => clearInterval(t));
    logUnsubs.current.forEach((u) => u());
    api.logs.stop();
    api.logs.stopCompose();
    api.exec.stop();
    api.events.stop();
  }, []);

  const setPendingFor = (id: string, verb: string | null) => {
    setPending((p) => {
      const next = new Map(p);
      if (verb) next.set(id, verb);
      else next.delete(id);
      return next;
    });
  };

  const containerAction = async (action: ActionName, id: string, compose = false) => {
    setPendingFor(id, ACTION_VERB[action]);
    try {
      const res = await api.container[action](id);
      if (!res.ok) showError(res.error);
    } finally {
      setPendingFor(id, null);
      await requestRefresh();
      if (compose) setTab('compose');
    }
  };

  const showRunCommand = async (id: string) => {
    const res = await api.container.inspect(id);
    if (!res.ok) { showError(res.error); return; }
    setCommand({ title: 'Run Command', text: buildRunCommand(res.info) });
  };

  const showInspector = async (id: string, name: string) => {
    const res = await api.container.inspect(id);
    if (!res.ok) { showError(res.error); return; }
    setInspector({ title: `Inspect - ${name}`, info: res.info });
  };

  const openPort = async (hostPort: string) => {
    const res = await api.system.openExternal(`http://localhost:${hostPort}`);
    if (!res.ok) showError(res.error);
  };

  const removeContainer = async (id: string, name: string) => {
    if (!confirm(`Remove container "${name}"? This cannot be undone.`)) return;
    const res = await api.container.remove(id, true);
    if (!res.ok) { showAlert(res.error, 'Could not remove container'); return; }
    await requestRefresh();
  };

  const openLogs = async (id: string, name: string) => {
    logUnsubs.current.forEach((u) => u());
    logUnsubs.current = [];
    await api.logs.stop();
    await api.logs.stopCompose();
    activeLogId.current = id;
    const startStream = async (options: LogStartOptions = DEFAULT_LOG_HISTORY) => {
      await api.logs.stop();
      activeLogId.current = id;
      const res = await api.logs.start(id, options);
      if (!res.ok) {
        logsRef.current?.write(`[failed to attach logs: ${res.error}]\n`, 'stderr');
        logsRef.current?.markStopped('could not attach to logs');
      }
    };
    await logsRef.current?.reset(`Logs · ${name}`, { kind: 'live' }, {
      history: true,
      historyMode: 'tail-500',
      onHistoryChange: startStream,
    });
    logUnsubs.current.push(api.logs.onData((p) => {
      if (p.id === activeLogId.current) logsRef.current?.write(p.line, p.stream);
    }));
    logUnsubs.current.push(api.logs.onEnd((p) => {
      if (p.id && p.id !== activeLogId.current) return;
      if (p.running) {
        nextLogStatus('live', { running: true });
        logsRef.current?.setStatus('live', 'live tail interrupted');
      } else {
        logsRef.current?.markStopped(p.error ? `stream error: ${p.error}` : 'container stopped - showing final logs');
      }
    }));
    await startStream(DEFAULT_LOG_HISTORY);
  };

  const handleComposeEnd = (p: ComposeLogEnd) => {
    if (p.running) {
      logsRef.current?.setStatus('live', 'live tail interrupted');
      return;
    }
    composeLive.current.delete(p.service);
    logsRef.current?.write(`${p.service} | --- exited ---\n`, 'stderr');
    if (composeLive.current.size === 0) logsRef.current?.markStopped('all services stopped');
    else logsRef.current?.setStatus('live', `${composeLive.current.size} running`);
  };

  const openComposeLogs = async (project: string, services: ContainerSummary[]) => {
    logUnsubs.current.forEach((u) => u());
    logUnsubs.current = [];
    await api.logs.stop();
    await api.logs.stopCompose();
    activeLogId.current = null;
    const list = services.map((s) => ({ id: s.id, service: s.composeService || s.name }));
    const resetComposeLive = () => {
      composeLive.current = new Map(services.filter((s) => s.state === 'running').map((s) => [s.composeService || s.name, { id: s.id, service: s.composeService || s.name }]));
    };
    const startComposeStream = async (options: LogStartOptions = DEFAULT_LOG_HISTORY) => {
      await api.logs.stopCompose();
      resetComposeLive();
      logsRef.current?.setStatus(composeLive.current.size ? 'live' : 'stopped', composeLive.current.size ? `${composeLive.current.size} running` : undefined);
      const res = await api.logs.startCompose(list, options);
      if (!res.ok) logsRef.current?.write(`[failed to attach compose logs: ${res.error}]\n`, 'stderr');
    };
    resetComposeLive();
    await logsRef.current?.reset(`Compose · ${project}`, composeLive.current.size ? { kind: 'live', text: `${composeLive.current.size} running` } : { kind: 'stopped' }, {
      history: true,
      historyMode: 'tail-500',
      onHistoryChange: startComposeStream,
    });
    logUnsubs.current.push(api.logs.onComposeData((p) => logsRef.current?.write(`${p.service.padEnd(12)} | ${p.line}`, p.stream)));
    logUnsubs.current.push(api.logs.onComposeEnd(handleComposeEnd));
    await startComposeStream(DEFAULT_LOG_HISTORY);
  };

  const viewColimaLogs = async () => {
    await logsRef.current?.reset('Colima · startup log', { kind: 'hidden' });
    const res = await api.colima.logs(profile);
    if (!res.ok) { logsRef.current?.write(`[${res.error}]\n`, 'stderr'); return; }
    logsRef.current?.write(res.text, 'stdout');
  };

  const startColima = async () => {
    setColimaBusy('starting…');
    await logsRef.current?.reset('Colima · starting…', { kind: 'hidden' });
    const unsub = api.colima.onStartLog((text) => logsRef.current?.write(text, 'stdout'));
    try {
      const res = await api.colima.start(profile);
      unsub();
      if (!res.ok) showError(res.error);
      await requestRefresh();
    } finally {
      setColimaBusy(null);
    }
  };

  const stopColima = async () => {
    setColimaBusy('stopping…');
    try {
      const res = await api.colima.stop(profile);
      if (!res.ok) showError(res.error);
      await requestRefresh();
    } finally {
      setColimaBusy(null);
    }
  };

  const openConfig = async () => {
    const res = await api.config.read(profile);
    if (!res.ok) {
      setConfig({ raw: '', parsed: {}, path: '', advanced: false, error: res.error });
      return;
    }
    setConfig({ raw: res.raw, parsed: res.parsed, path: res.path, advanced: false });
  };

  const saveConfig = async (restart: boolean) => {
    if (!config) return;
    const content = config.advanced ? config.raw : {
      ...config.parsed,
      cpu: Number((document.getElementById('cfg-cpu') as HTMLInputElement)?.value || config.parsed.cpu || 2),
      memory: Number((document.getElementById('cfg-memory') as HTMLInputElement)?.value || config.parsed.memory || 2),
      disk: Number((document.getElementById('cfg-disk') as HTMLInputElement)?.value || config.parsed.disk || 60),
      runtime: (document.getElementById('cfg-runtime') as HTMLSelectElement)?.value || config.parsed.runtime || 'docker',
      vmType: (document.getElementById('cfg-vmtype') as HTMLSelectElement)?.value || config.parsed.vmType || 'qemu',
      kubernetes: { ...(config.parsed.kubernetes || {}), enabled: ((document.getElementById('cfg-kubernetes') as HTMLSelectElement)?.value || 'false') === 'true' },
    };
    localStorage.setItem('cpu-display', (document.getElementById('cfg-cpu-normalize') as HTMLSelectElement)?.value || 'normalized');
    localStorage.setItem('stats-interval', (document.getElementById('cfg-stats-interval') as HTMLSelectElement)?.value || '5');
    const maxLogLines = Number((document.getElementById('cfg-log-max-lines') as HTMLInputElement)?.value || 10000);
    localStorage.setItem('log-max-lines', String(Math.max(500, Math.min(100000, Math.floor(Number.isFinite(maxLogLines) ? maxLogLines : 10000)))));
    const res = await api.config.write(profile, content);
    if (!res.ok) { setConfig({ ...config, error: res.error }); return; }
    setConfig(null);
    if (restart) {
      setColimaBusy('stopping…');
      const stopRes = await api.colima.stop(profile);
      if (!stopRes.ok) { showError(stopRes.error); setColimaBusy(null); return; }
      setColimaBusy('starting…');
      const startRes = await api.colima.start(profile);
      if (!startRes.ok) showError(startRes.error);
      setColimaBusy(null);
    }
    await requestRefresh();
  };

  const imageRows = images.flatMap((img) => img.tags.map((tag) => ({ ...img, tag })));
  const composeProjects = useMemo(() => groupComposeProjects(containers), [containers]);
  const selectedProfile = profiles.find((p) => p.name === profile) || profiles[0];

  return (
    <div id="app" class={sidebarExpanded ? 'sidebar-expanded' : ''}>
      <Sidebar
        tab={tab}
        expanded={sidebarExpanded}
        onTab={setTab}
        onExpand={() => { const next = !sidebarExpanded; setSidebarExpanded(next); localStorage.setItem('sidebar-expanded', next ? '1' : ''); }}
        onRefresh={requestRefresh}
        onConfig={openConfig}
      />
      {toast && <Toast {...toast} onClose={() => setToast(null)} />}
      <main id="main">
        <div class="search-bar"><input class="filter-input" value={filter} onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)} placeholder="Filter by name, image, or tag…" /></div>
        {tab === 'containers' && <ContainersView containers={containers} pending={pending} stats={stats} filter={filter} onAction={containerAction} onRemove={removeContainer} onLogs={openLogs} onShell={setShell} onCommand={showRunCommand} onInspect={showInspector} onOpenPort={openPort} />}
        {tab === 'images' && <ImagesView rows={imageRows} filter={filter} onRemove={async (id: string, tag: string) => {
          if (!confirm(`Remove image "${tag}"?`)) return;
          const res = await api.image.remove(id, true);
          if (!res.ok) { showAlert(res.error, 'Could not remove image'); return; }
          await requestRefresh();
        }} onPrune={async () => {
          const res = await api.image.listDangling();
          if (!res.ok) { showError(res.error); return; }
          const total = res.images.reduce((s, i) => s + (i.size || 0), 0);
          setPrune({ title: 'Prune dangling images', summary: res.images.length ? `${res.images.length} dangling image(s) will be removed. Tagged images are kept.` : 'No dangling images to remove.', rows: res.images.map((i) => [i.id, '<none>', humanSize(i.size)]), total: `Reclaims ~${humanSize(total)}`, confirm: `Remove ${res.images.length} image(s)`, onConfirm: async () => {
            const r = await api.image.prune(); if (!r.ok) { showError(r.error); return; } flashSuccess(`Pruned ${r.deleted || 0} image(s) - reclaimed ${humanSize(r.reclaimed)}`); requestRefresh();
          } });
        }} />}
        {tab === 'volumes' && <VolumesView volumes={volumes} filter={filter} onInspect={async (name: string) => { const res = await api.volume.inspect(name); if (!res.ok) showError(res.error); else setCommand({ title: `Volume - ${name}`, text: JSON.stringify(res.info, null, 2) }); }} onRemove={async (name: string) => { if (!confirm(`Remove volume "${name}"? Data will be lost.`)) return; const res = await api.volume.remove(name); if (!res.ok) { showAlert(res.error, 'Could not remove volume'); return; } requestRefresh(); }} onPrune={async () => {
          const res = await api.volume.listPrunable(); if (!res.ok) { showError(res.error); return; }
          setPrune({ title: 'Prune unused volumes', summary: res.volumes.length ? `${res.volumes.length} unused volume(s) will be removed. Data in them will be lost.` : 'No unused volumes to remove.', rows: res.volumes.map((v) => [v.name, v.driver]), confirm: `Remove ${res.volumes.length} volume(s)`, onConfirm: async () => { const r = await api.volume.prune(); if (!r.ok) { showError(r.error); return; } flashSuccess(`Pruned ${r.count} volume(s) - reclaimed ${humanSize(r.reclaimed)}`); requestRefresh(); } });
        }} />}
        {tab === 'compose' && <ComposeView projects={composeProjects} collapsed={composeCollapsed} pending={pending} filter={filter} onToggle={(p: string) => setComposeCollapsed((old) => { const next = new Set(old); next.has(p) ? next.delete(p) : next.add(p); localStorage.setItem('compose-collapsed', JSON.stringify([...next])); return next; })} onLogs={openComposeLogs} onSvcAction={(a: ActionName, id: string) => containerAction(a, id, true)} onBulk={async (services: ContainerSummary[], action: ActionName) => { const targets = services.filter((s: ContainerSummary) => action === 'start' ? s.state !== 'running' : action === 'stop' ? s.state === 'running' : true); await Promise.all(targets.map((s: ContainerSummary) => containerAction(action, s.id, true))); }} onShell={setShell} onCommand={showRunCommand} onInspect={showInspector} onContainerLogs={openLogs} onOpenPort={openPort} />}
        {tab === 'networks' && <NetworksView networks={networks} filter={filter} onInspect={async (id: string) => { const res = await api.network.inspect(id); if (!res.ok) showError(res.error); else setCommand({ title: `Network - ${res.info.Name}`, text: JSON.stringify(res.info, null, 2) }); }} onRemove={async (id: string, name: string) => { if (!confirm(`Remove network "${name}"?`)) return; const res = await api.network.remove(id); if (!res.ok) { showAlert(res.error, 'Could not remove network'); return; } requestRefresh(); }} onPrune={async () => { const res = await api.network.listPrunable(); if (!res.ok) { showError(res.error); return; } setPrune({ title: 'Prune unused networks', summary: res.networks.length ? `${res.networks.length} unused network(s) will be removed.` : 'No unused networks to remove.', rows: res.networks.map((n) => [n.name, n.driver]), confirm: `Remove ${res.networks.length} network(s)`, onConfirm: async () => { const r = await api.network.prune(); if (!r.ok) { showError(r.error); return; } flashSuccess(`Pruned ${r.count} network(s)`); requestRefresh(); } }); }} />}
      </main>
      <EngineStatusBar
        profile={selectedProfile}
        running={running}
        busy={colimaBusy}
        containers={containers}
        stats={stats}
        theme={theme}
        onStart={startColima}
        onStop={stopColima}
        onLogs={viewColimaLogs}
        onTheme={setTheme}
      />
      <LogsDrawer ref={logsRef} open={logsOpen} onOpenChange={setLogsOpen} onClose={() => setLogsOpen(false)} />
      <ShellModal container={shell} onClose={() => setShell(null)} />
      {alert && <AlertModal {...alert} onClose={() => setAlert(null)} />}
      {command && <CommandModal command={command} onClose={() => setCommand(null)} />}
      {inspector && <ContainerInspectorModal inspector={inspector} onClose={() => setInspector(null)} />}
      {prune && <PruneModal prune={prune} onClose={() => setPrune(null)} />}
      {config && <ConfigModal config={config} onChange={setConfig} onClose={() => setConfig(null)} onSave={saveConfig} />}
    </div>
  );
}

function parsePublishedPort(port: string) {
  const match = port.match(/^(\d+):(\d+)\/([a-z0-9]+)$/i);
  if (!match) return null;
  return { hostPort: match[1], containerPort: match[2], protocol: match[3] };
}

function PortsCell({ ports, onOpenPort }: { ports: string[]; onOpenPort: (hostPort: string) => void }) {
  if (!ports.length) return <span class="muted">—</span>;
  const uniquePorts = [...new Set(ports)];
  return (
    <span class="port-list">
      {uniquePorts.map((port) => {
        const parsed = parsePublishedPort(port);
        if (!parsed) return <span class="port-chip" key={port}>{port}</span>;
        return (
          <button
            class="port-link"
            key={port}
            title={`Open http://localhost:${parsed.hostPort}`}
            onClick={() => onOpenPort(parsed.hostPort)}
          >
            {parsed.hostPort}:{parsed.containerPort}/{parsed.protocol}
          </button>
        );
      })}
    </span>
  );
}

function ContainersView({ containers, pending, stats, filter, onAction, onRemove, onLogs, onShell, onCommand, onInspect, onOpenPort }: any) {
  const columns: Column<ContainerSummary>[] = [
    { title: 'State', type: 'text', value: (c) => c.state, render: (c) => <StatusPill text={c.state} tone={c.state === 'running' ? 'running' : 'stopped'} /> },
    { title: 'Name', type: 'text', className: 'col-name', value: (c) => c.name, render: (c) => c.name },
    { title: 'Image', type: 'text', className: 'mono col-image', value: (c) => c.image, render: (c) => c.image },
    { title: 'CPU / Mem', render: (c) => pending.has(c.id) ? <span class="row-spinner" /> : statMarkup(stats[c.id], c.state !== 'running') },
    { title: 'Ports', render: (c) => <PortsCell ports={c.ports} onOpenPort={onOpenPort} /> },
    { title: 'Status', type: 'text', className: 'col-status', value: (c) => pending.get(c.id) || c.status, render: (c) => pending.get(c.id) ? <span class="svc-pending">{pending.get(c.id)}</span> : <span class="status-text">{c.status}</span> },
    { title: '', render: (c) => pending.has(c.id) ? <span class="row-spinner" /> : <div class="actions">{c.state === 'running' ? <><Button label="Stop" className="btn btn-red btn-sm" onClick={() => onAction('stop', c.id)} /><Button label="Restart" className="btn btn-ghost btn-sm" onClick={() => onAction('restart', c.id)} /></> : <><Button label="Start" className="btn btn-green btn-sm" onClick={() => onAction('start', c.id)} /><Button label="Remove" className="btn btn-red btn-sm" onClick={() => onRemove(c.id, c.name)} /></>}<ActionMenu items={[{ label: 'Logs', icon: 'logs', action: () => onLogs(c.id, c.name) }, ...(c.state === 'running' ? [{ label: 'Shell', icon: 'shell' as const, action: () => onShell({ id: c.id, name: c.name }) }] : []), { label: 'Inspect', icon: 'command', action: () => onInspect(c.id, c.name) }, { label: 'Copy docker run', icon: 'command', action: () => onCommand(c.id) }]} /></div> },
  ];
  return <section class="view"><DataTable id="containers-table" rows={containers} columns={columns} empty="No containers." filter={filter} rowKey={(c) => c.id} /></section>;
}

function ImagesView({ rows, filter, onRemove, onPrune }: any) {
  const columns = [
    { title: 'Repository:Tag', type: 'text' as const, value: (r: any) => r.tag, render: (r: any) => r.tag, className: 'mono' },
    { title: 'Image ID', type: 'text' as const, value: (r: any) => r.id, render: (r: any) => r.id, className: 'mono muted' },
    { title: 'Size', type: 'size' as const, value: (r: any) => humanSize(r.size), render: (r: any) => humanSize(r.size) },
    { title: '', render: (r: any) => <div class="actions"><ActionMenu items={[{ label: 'Remove', icon: 'remove', danger: true, action: () => onRemove(r.id, r.tag) }]} /></div> },
  ];
  return <section class="view"><div class="view-toolbar"><button class="btn btn-ghost" onClick={onPrune}>Prune dangling images</button></div><DataTable id="images-table" rows={rows} columns={columns} empty="No images." filter={filter} rowKey={(r) => `${r.id}-${r.tag}`} /></section>;
}

function VolumesView({ volumes, filter, onInspect, onRemove, onPrune }: any) {
  const columns: Column<VolumeSummary>[] = [
    { title: 'Name', type: 'text', value: (v) => v.name, render: (v) => v.name.length > 40 ? `${v.name.slice(0, 37)}…` : v.name, className: 'mono' },
    { title: 'Driver', type: 'text', value: (v) => v.driver, render: (v) => v.driver, className: 'muted' },
    { title: 'Created', type: 'date', value: (v) => formatDate(v.created), render: (v) => formatDate(v.created), className: 'muted' },
    { title: '', render: (v) => <div class="actions"><ActionMenu items={[{ label: 'Inspect', icon: 'command', action: () => onInspect(v.name) }, { separator: true }, { label: 'Remove', icon: 'remove', danger: true, action: () => onRemove(v.name) }]} /></div> },
  ];
  return <section class="view"><div class="view-toolbar"><button class="btn btn-ghost" onClick={onPrune}>Prune unused volumes</button></div><DataTable id="volumes-table" rows={volumes} columns={columns} empty="No volumes." filter={filter} rowKey={(v) => v.name} /></section>;
}

function ComposeView({ projects, collapsed, pending, filter, onToggle, onLogs, onSvcAction, onBulk, onShell, onCommand, onInspect, onContainerLogs, onOpenPort }: any) {
  const entries = [...projects.entries()].filter(([project, services]) => !filter || `${project} ${JSON.stringify(services)}`.toLowerCase().includes(filter.toLowerCase()));
  if (!entries.length) return <section class="view"><div class="empty">No Compose projects found.<br /><span class="muted" style={{ fontSize: 11 }}>Containers started with <code>docker compose</code> appear here grouped by project.</span></div></section>;
  return <section class="view">{entries.map(([project, services]: [string, ContainerSummary[]]) => {
    const runningCount = services.filter((s) => s.state === 'running').length;
    const allRunning = runningCount === services.length;
    const isCollapsed = collapsed.has(project);
    const workdirs = [...new Set(services.map((s) => s.composeWorkdir).filter(Boolean))] as string[];
    const configFiles = [...new Set(services.flatMap((s) => (s.composeConfigFiles || '').split(',').filter(Boolean)))];
    const serviceNames = services.map((s) => s.composeService || s.name);
    const exposedPorts = [...new Set(services.flatMap((s) => s.ports))];
    const dependencies = services
      .map((s) => [s.composeService || s.name, s.composeDependsOn || ''] as const)
      .filter(([, deps]) => deps);
    return <div class="compose-group" key={project}><div class="compose-header"><div class="compose-header-left" onClick={() => onToggle(project)}><svg class={`compose-caret ${isCollapsed ? 'collapsed' : ''}`} viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="compose-name">{project}</span><span class={`compose-badge ${allRunning ? 'badge-running' : runningCount ? 'badge-partial' : 'badge-stopped'}`}>{runningCount}/{services.length} running</span></div><div class="compose-actions"><Button label="Logs" className="btn btn-ghost btn-sm" onClick={() => onLogs(project, services)} /><Button label="Start" className="btn btn-green btn-sm" disabled={allRunning} onClick={() => onBulk(services, 'start')} /><Button label="Stop" className="btn btn-red btn-sm" disabled={runningCount === 0} onClick={() => onBulk(services, 'stop')} /><Button label="Restart" className="btn btn-ghost btn-sm" disabled={runningCount === 0} onClick={() => onBulk(services, 'restart')} /></div></div>{!isCollapsed && <><div class="compose-meta"><div><span>Working Dir</span><strong>{workdirs.join(', ') || '—'}</strong></div><div><span>Compose Files</span><strong>{configFiles.join(', ') || '—'}</strong></div><div><span>Services</span><strong>{serviceNames.join(', ')}</strong></div><div><span>Published Ports</span><strong>{exposedPorts.join(', ') || '—'}</strong></div>{dependencies.length > 0 && <div><span>Depends On</span><strong>{dependencies.map(([svc, deps]) => `${svc}: ${deps}`).join(' · ')}</strong></div>}</div><table class="grid compose-services"><tbody>{services.map((c) => <tr key={c.id} data-svc-id={c.id}><td class="compose-svc-state">{pending.has(c.id) ? <span class="row-spinner" /> : <StatusPill text={c.state} tone={c.state === 'running' ? 'running' : 'stopped'} />}</td><td class="compose-svc-name">{c.composeService || c.name}{c.composeContainerNumber && <span class="net-builtin">#{c.composeContainerNumber}</span>}</td><td class="mono muted compose-svc-image">{c.image}</td><td class="ports compose-svc-ports"><PortsCell ports={c.ports} onOpenPort={onOpenPort} /></td><td class="compose-svc-status">{pending.get(c.id) ? <span class="svc-pending">{pending.get(c.id)}</span> : <span class="status-text">{c.status}</span>}</td><td class="col-actions"><div class="actions">{c.state === 'running' ? <><Button label="Stop" className="btn btn-red btn-sm" onClick={() => onSvcAction('stop', c.id)} /><Button label="Restart" className="btn btn-ghost btn-sm" onClick={() => onSvcAction('restart', c.id)} /></> : <Button label="Start" className="btn btn-green btn-sm" onClick={() => onSvcAction('start', c.id)} />}<ActionMenu items={[{ label: 'Logs', icon: 'logs', action: () => onContainerLogs(c.id, c.name) }, ...(c.state === 'running' ? [{ label: 'Shell', icon: 'shell' as const, action: () => onShell({ id: c.id, name: c.name }) }] : []), { label: 'Inspect', icon: 'command', action: () => onInspect(c.id, c.name) }, { label: 'Copy docker run', icon: 'command', action: () => onCommand(c.id) }]} /></div></td></tr>)}</tbody></table></>}</div>;
  })}</section>;
}

function NetworksView({ networks, filter, onInspect, onRemove, onPrune }: any) {
  const columns: Column<NetworkSummary>[] = [
    { title: 'Name', type: 'text', value: (n) => n.name, render: (n) => <>{n.name}{n.builtin && <span class="net-builtin">built-in</span>}</>, className: 'mono' },
    { title: 'Driver', type: 'text', value: (n) => n.driver, render: (n) => n.driver, className: 'muted' },
    { title: 'Scope', type: 'text', value: (n) => n.scope, render: (n) => n.scope, className: 'muted' },
    { title: 'Subnet', type: 'text', value: (n) => n.ipam || '—', render: (n) => n.ipam || '—', className: 'mono muted' },
    { title: 'Containers', type: 'num', value: (n) => n.containerCount ?? 0, render: (n) => n.containerCount == null ? '—' : n.containerCount, className: 'muted' },
    { title: '', render: (n) => <div class="actions"><ActionMenu items={[{ label: 'Inspect', icon: 'command', action: () => onInspect(n.id) }, ...(!n.builtin ? [{ separator: true }, { label: 'Remove', icon: 'remove' as const, danger: true, action: () => onRemove(n.id, n.name) }] : [])]} /></div> },
  ];
  return <section class="view"><div class="view-toolbar"><button class="btn btn-ghost" onClick={onPrune}>Prune unused networks</button></div><DataTable id="networks-table" rows={networks} columns={columns} empty="No networks." filter={filter} rowKey={(n) => n.id} /></section>;
}

function splitEnv(env: string) {
  const idx = env.indexOf('=');
  return idx === -1 ? [env, ''] : [env.slice(0, idx), env.slice(idx + 1)];
}

function healthStatus(info: any) {
  const health = info.State?.Health;
  if (health?.Status) return health.Status;
  if (info.State?.Running) return 'running';
  return info.State?.Status || 'unknown';
}

function boolText(value: any) {
  return value === true ? 'yes' : value === false ? 'no' : '—';
}

function dockerTimestamp(value: any) {
  const text = String(value || '');
  return text && !text.startsWith('0001-01-01') ? text : '';
}

function InspectRows({ rows, empty = '—' }: { rows: string[][]; empty?: string }) {
  if (!rows.length) return <div class="empty compact-empty">{empty}</div>;
  return (
    <div class="inspect-rows">
      {rows.map(([key, value]) => (
        <div class="inspect-row" key={key}>
          <div class="inspect-key">{key}</div>
          <div class="inspect-value">{value || '—'}</div>
        </div>
      ))}
    </div>
  );
}

function ContainerInspectorModal({ inspector, onClose }: any) {
  const [tab, setTab] = useState('overview');
  const [copied, setCopied] = useState(false);
  const info = inspector.info || {};
  const cfg = info.Config || {};
  const host = info.HostConfig || {};
  const state = info.State || {};
  const restart = host.RestartPolicy || {};
  const health = state.Health || {};
  const healthcheck = cfg.Healthcheck || {};
  const name = (info.Name || '').replace(/^\//, '') || inspector.title;
  const startedAt = dockerTimestamp(state.StartedAt);
  const finishedAt = dockerTimestamp(state.FinishedAt);
  const finishedLabel = state.Running ? 'Previous Finish' : 'Finished';
  const command = [
    ...(Array.isArray(cfg.Entrypoint) ? cfg.Entrypoint : cfg.Entrypoint ? [cfg.Entrypoint] : []),
    ...(Array.isArray(cfg.Cmd) ? cfg.Cmd : cfg.Cmd ? [cfg.Cmd] : []),
  ].join(' ');
  const tabs = [
    ['overview', 'Overview'],
    ['health', `Health · ${healthStatus(info)}`],
    ['command', 'Command'],
    ['env', `Env (${(cfg.Env || []).length})`],
    ['mounts', `Mounts (${(info.Mounts || []).length})`],
    ['networks', `Networks (${Object.keys(info.NetworkSettings?.Networks || {}).length})`],
    ['labels', `Labels (${Object.keys(cfg.Labels || {}).length})`],
  ];
  const overviewRows = [
    ['Name', name],
    ['ID', info.Id || ''],
    ['Image', cfg.Image || info.Image || ''],
    ['State', state.Status || ''],
    ['Started', startedAt],
    ['Created', info.Created || ''],
    ['Restart', restart.Name && restart.Name !== 'no' ? `${restart.Name}${restart.MaximumRetryCount ? `:${restart.MaximumRetryCount}` : ''}` : 'no'],
  ];
  const commandRows = [
    ['Path', info.Path || ''],
    ['Args', Array.isArray(info.Args) ? info.Args.join(' ') : ''],
    ['Entrypoint', Array.isArray(cfg.Entrypoint) ? cfg.Entrypoint.join(' ') : cfg.Entrypoint || ''],
    ['Cmd', Array.isArray(cfg.Cmd) ? cfg.Cmd.join(' ') : cfg.Cmd || ''],
    ['Resolved', command],
    ['Working Dir', cfg.WorkingDir || ''],
    ['User', cfg.User || ''],
  ];
  const healthRows = [
    ['Status', healthStatus(info)],
    ['Running', boolText(state.Running)],
    ['Restarting', boolText(state.Restarting)],
    ['Restart Count', String(info.RestartCount ?? 0)],
    ['Exit Code', String(state.ExitCode ?? '—')],
    ['OOM Killed', boolText(state.OOMKilled)],
    ['Dead', boolText(state.Dead)],
    ['Error', state.Error || '—'],
    ['Started', startedAt || '—'],
    [finishedLabel, finishedAt || '—'],
    ['Health Failing Streak', String(health.FailingStreak ?? '—')],
    ['Healthcheck', Array.isArray(healthcheck.Test) ? healthcheck.Test.join(' ') : '—'],
    ['Interval', healthcheck.Interval ? `${Math.round(healthcheck.Interval / 1e9)}s` : '—'],
    ['Timeout', healthcheck.Timeout ? `${Math.round(healthcheck.Timeout / 1e9)}s` : '—'],
    ['Retries', String(healthcheck.Retries ?? '—')],
    ['Start Period', healthcheck.StartPeriod ? `${Math.round(healthcheck.StartPeriod / 1e9)}s` : '—'],
  ];
  const healthLogRows = (health.Log || []).slice(-5).flatMap((h: any, idx: number) => [
    [`Check ${idx + 1} Time`, `${h.Start || '—'} → ${h.End || '—'}`],
    [`Check ${idx + 1} Exit`, String(h.ExitCode ?? '—')],
    [`Check ${idx + 1} Output`, String(h.Output || '').trim() || '—'],
  ]);
  const envRows = (cfg.Env || []).map((env: string) => splitEnv(env));
  const mountRows = (info.Mounts || []).map((m: any) => [m.Destination || m.Target || '', `${m.Source || m.Name || 'anonymous'}${m.RW === false ? ' (ro)' : ''}`]);
  const networkRows = Object.entries(info.NetworkSettings?.Networks || {}).flatMap(([network, net]: [string, any]) => [
    [`${network} IP`, net.IPAddress || ''],
    [`${network} Gateway`, net.Gateway || ''],
    [`${network} MAC`, net.MacAddress || ''],
  ]);
  const labelRows = Object.entries(cfg.Labels || {}).map(([key, value]) => [key, String(value)]);

  return (
    <Modal
      title={inspector.title}
      width={760}
      onClose={onClose}
      headerActions={<button class="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard.writeText(JSON.stringify(info, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied!' : 'Copy JSON'}</button>}
    >
      <div class="inspect-tabs">
        {tabs.map(([id, label]) => <button class={`inspect-tab ${tab === id ? 'active' : ''}`} key={id} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      <div class="inspect-panel">
        {tab === 'overview' && <InspectRows rows={overviewRows} />}
        {tab === 'health' && <InspectRows rows={[...healthRows, ...healthLogRows]} empty="No health data." />}
        {tab === 'command' && <InspectRows rows={commandRows} />}
        {tab === 'env' && <InspectRows rows={envRows} empty="No environment variables." />}
        {tab === 'mounts' && <InspectRows rows={mountRows} empty="No mounts." />}
        {tab === 'networks' && <InspectRows rows={networkRows} empty="No networks." />}
        {tab === 'labels' && <InspectRows rows={labelRows} empty="No labels." />}
      </div>
    </Modal>
  );
}

function CommandModal({ command, onClose }: any) {
  const [copied, setCopied] = useState(false);
  return <Modal title={command.title} width={620} onClose={onClose} headerActions={<button class="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard.writeText(command.text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied!' : 'Copy'}</button>}><pre class="command-output">{command.text}</pre></Modal>;
}

function PruneModal({ prune, onClose }: any) {
  const canRemove = prune.rows.length > 0;
  return <Modal title={prune.title} onClose={onClose} footer={<><span class="muted config-path-label">{prune.total || ''}</span><div class="modal-footer-actions"><button class="btn btn-ghost" onClick={onClose}>Cancel</button>{canRemove && <button class="btn btn-red" onClick={async () => { onClose(); await prune.onConfirm?.(); }}>{prune.confirm || 'Remove'}</button>}</div></>}><p class="muted" style={{ marginTop: 0 }}>{prune.summary}</p><div class="prune-list">{prune.rows.map((row: string[]) => <div class="prune-row">{row.map((c) => <span>{c}</span>)}</div>)}</div></Modal>;
}

function ConfigModal({ config, onChange, onClose, onSave }: any) {
  const p = config.parsed || {};
  return <Modal title="Configuration" onClose={onClose} closeOnOverlayClick={false} headerActions={<button class="btn btn-ghost btn-sm" onClick={() => onChange({ ...config, advanced: !config.advanced })}>{config.advanced ? 'Simple' : 'Advanced'}</button>} footer={<><span class="muted config-path-label">{config.path}</span><div class="modal-footer-actions"><button class="btn btn-green" onClick={() => onSave(true)}>Save & Restart</button><button class="btn btn-ghost" onClick={() => onSave(false)}>Save</button></div></>}>{!config.advanced ? <div><div class="config-section-label">GUI Settings</div><div class="config-field"><label>Stats Refresh</label><select id="cfg-stats-interval" class="config-input" value={localStorage.getItem('stats-interval') || '5'}><option value="2">2s</option><option value="5">5s</option><option value="10">10s</option><option value="15">15s</option><option value="30">30s</option></select></div><div class="config-field"><label>CPU % Display</label><select id="cfg-cpu-normalize" class="config-input" value={localStorage.getItem('cpu-display') || 'normalized'}><option value="normalized">Normalized (max 100%)</option><option value="raw">Per-core (max N×100%)</option></select></div><div class="config-field"><label>Max Log Lines</label><input id="cfg-log-max-lines" type="number" min="500" max="100000" step="500" class="config-input" defaultValue={localStorage.getItem('log-max-lines') || '10000'} /></div><div class="config-section-label">Colima VM</div><div class="config-field"><label>CPU</label><input id="cfg-cpu" type="number" min="1" max="32" class="config-input" defaultValue={p.cpu || 2} /></div><div class="config-field"><label>Memory (GB)</label><input id="cfg-memory" type="number" min="1" max="128" class="config-input" defaultValue={p.memory || 2} /></div><div class="config-field"><label>Disk (GB)</label><input id="cfg-disk" type="number" min="10" max="1000" class="config-input" defaultValue={p.disk || 60} /></div><div class="config-field"><label>Runtime</label><select id="cfg-runtime" class="config-input" defaultValue={p.runtime || 'docker'}><option value="docker">docker</option><option value="containerd">containerd</option></select></div><div class="config-field"><label>Kubernetes</label><select id="cfg-kubernetes" class="config-input" defaultValue={String(!!p.kubernetes?.enabled)}><option value="false">Disabled</option><option value="true">Enabled</option></select></div><div class="config-field"><label>VM Type</label><select id="cfg-vmtype" class="config-input" defaultValue={p.vmType || 'qemu'}><option value="qemu">qemu</option><option value="vz">vz (macOS Virtualization.framework)</option></select></div></div> : <textarea class="config-editor" spellcheck={false} value={config.raw} onInput={(e) => onChange({ ...config, raw: (e.currentTarget as HTMLTextAreaElement).value })} />}{config.error && <div class="config-error">{config.error}</div>}</Modal>;
}
