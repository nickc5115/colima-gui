import { Icons } from './icons';
import type { ColimaProfile, Tab, ThemePref } from '../types';
import brandLogo from '../../../assets/brand-logo.png';
import { humanSize } from '../utils/format';

const tabs: Array<{ tab: Tab; label: string; icon: keyof typeof Icons }> = [
  { tab: 'containers', label: 'Containers', icon: 'containers' },
  { tab: 'images', label: 'Images', icon: 'images' },
  { tab: 'volumes', label: 'Volumes', icon: 'volumes' },
  { tab: 'compose', label: 'Compose', icon: 'compose' },
  { tab: 'networks', label: 'Networks', icon: 'networks' },
];

export function Sidebar({
  tab,
  profiles,
  profile,
  running,
  expanded,
  theme,
  onTheme,
  onProfile,
  onTab,
  onExpand,
  onRefresh,
  onConfig,
  onStart,
  onStop,
  onLogs,
  colimaBusy,
}: {
  tab: Tab;
  profiles: ColimaProfile[];
  profile: string;
  running: boolean;
  expanded: boolean;
  theme: ThemePref;
  onTheme: (v: ThemePref) => void;
  onProfile: (v: string) => void;
  onTab: (v: Tab) => void;
  onExpand: () => void;
  onRefresh: () => void;
  onConfig: () => void;
  onStart: () => void;
  onStop: () => void;
  onLogs: () => void;
  colimaBusy: string | null;
}) {
  const selected = profiles.find((p) => p.name === profile) || profiles[0];
  const status = colimaBusy || selected?.status || 'unknown';
  return (
    <aside id="sidebar">
      <div class="brand">
        <img class="logo" src={brandLogo} alt="" />
        <span class="brand-text">Colima Desktop</span>
        <select class="theme-select" value={theme} onChange={(e) => onTheme((e.currentTarget as HTMLSelectElement).value as ThemePref)}>
          <option value="system">☀︎ System</option>
          <option value="dark">🌙 Dark</option>
          <option value="light">☀︎ Light</option>
        </select>
      </div>

      <div class="colima-card">
        <div class="row">
          <span class="muted">Profile</span>
          <select class="profile-select" value={profile} onChange={(e) => onProfile((e.currentTarget as HTMLSelectElement).value)}>
            {(profiles.length ? profiles : [{ name: 'default', status: 'unknown' }]).map((p) => <option value={p.name}>{p.name}</option>)}
          </select>
        </div>
        <div class="row">
          <span class="muted">Status</span>
          <span class={`status ${running ? 'status-running' : status === 'unknown' ? 'status-unknown' : 'status-stopped'}`}>{status}</span>
        </div>
        <div class="row">
          {running && selected && (
            <>
              <span>{selected.cpus} CPU</span>
              <span>{humanSize(selected.memory)} RAM</span>
              <span>{selected.runtime}</span>
            </>
          )}
        </div>
        <div class="colima-actions">
          <button class={`btn btn-green${colimaBusy === 'starting…' ? ' loading' : ''}`} disabled={running || !!colimaBusy} onClick={onStart}>Start</button>
          <button class={`btn btn-red${colimaBusy === 'stopping…' ? ' loading' : ''}`} disabled={!running || !!colimaBusy} onClick={onStop}>Stop</button>
        </div>
        <button class="btn btn-ghost btn-sm colima-logs-btn" onClick={onLogs}>View startup logs</button>
      </div>

      <nav class="sidebar-nav">
        {tabs.map((t) => (
          <button class={`nav-item ${tab === t.tab ? 'active' : ''}`} data-tip={t.label} onClick={() => onTab(t.tab)}>
            {Icons[t.icon]}<span class="nav-label">{t.label}</span>
          </button>
        ))}
      </nav>
      <div class="sidebar-bottom">
        <div class="sidebar-nav-sep" />
        <button class="nav-item" data-tip="Configuration" onClick={onConfig}>{Icons.config}<span class="nav-label">Configuration</span></button>
        <button class="nav-item" data-tip="Refresh" onClick={onRefresh}>{Icons.refresh}<span class="nav-label">Refresh</span></button>
        <button class="sidebar-expand" data-tip={expanded ? 'Collapse' : 'Expand'} onClick={onExpand}>
          <svg viewBox="0 0 16 16" class="sidebar-expand-icon"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </aside>
  );
}
