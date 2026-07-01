import { Icons } from './icons';
import type { Tab } from '../types';
import brandLogo from '../../../assets/brand-logo.png';

const tabs: Array<{ tab: Tab; label: string; icon: keyof typeof Icons }> = [
  { tab: 'containers', label: 'Containers', icon: 'containers' },
  { tab: 'images', label: 'Images', icon: 'images' },
  { tab: 'volumes', label: 'Volumes', icon: 'volumes' },
  { tab: 'compose', label: 'Compose', icon: 'compose' },
  { tab: 'networks', label: 'Networks', icon: 'networks' },
];

export function Sidebar({
  tab,
  expanded,
  onTab,
  onExpand,
  onRefresh,
  onConfig,
}: {
  tab: Tab;
  expanded: boolean;
  onTab: (v: Tab) => void;
  onExpand: () => void;
  onRefresh: () => void;
  onConfig: () => void;
}) {
  return (
    <aside id="sidebar">
      <div class="brand">
        <img class="logo" src={brandLogo} alt="" />
        <span class="brand-text"><span>Colima</span><span>Desktop</span></span>
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
