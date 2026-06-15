'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// --------------------------------------------------------------------------
// Theme
// --------------------------------------------------------------------------
function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(pref) {
  const resolved = pref === 'system' ? getSystemTheme() : pref;
  document.documentElement.setAttribute('data-theme', resolved);
}

function initTheme() {
  const saved = localStorage.getItem('theme') || 'system';
  $('#theme-select').value = saved;
  applyTheme(saved);
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if ($('#theme-select').value === 'system') applyTheme('system');
  });
}

$('#theme-select').addEventListener('change', () => {
  const pref = $('#theme-select').value;
  localStorage.setItem('theme', pref);
  applyTheme(pref);
});

const state = {
  tab: 'containers',
  logUnsub: null,
  endUnsub: null,
  currentLogId: null,
  eventUnsub: null,
  eventEndUnsub: null,
  statsTimers: new Map(),
};

function showError(msg) {
  const el = $('#global-error');
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = msg;
  el.classList.remove('hidden');
}

function humanSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// --------------------------------------------------------------------------
// Resizable columns
// --------------------------------------------------------------------------
function makeResizable(tableId, storageKey, defaultWidths) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const thead = table.querySelector('thead tr');
  if (!thead) return;
  const ths = Array.from(thead.children);

  const saved = localStorage.getItem(storageKey);
  let widths = saved ? JSON.parse(saved) : null;
  if (!widths || widths.length !== ths.length) widths = defaultWidths;

  let saveTimer = null;
  function applyWidths(persist) {
    ths.forEach((th, i) => { th.style.width = widths[i] + '%'; });
    if (persist !== false) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => localStorage.setItem(storageKey, JSON.stringify(widths)), 200);
    }
  }
  applyWidths();

  ths.forEach((th, i) => {
    if (i === ths.length - 1) return;
    const handle = document.createElement('div');
    handle.className = 'col-resizer';
    th.appendChild(handle);

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle.classList.add('active');
      document.body.classList.add('col-resizing');
      const tableWidth = table.offsetWidth;
      const startX = e.clientX;
      const startW = widths[i];
      const nextW = widths[i + 1];
      let raf = null;

      function onMove(ev) {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          const dx = ev.clientX - startX;
          const pctDelta = (dx / tableWidth) * 100;
          const newW = Math.max(3, startW + pctDelta);
          const newNext = Math.max(3, nextW - pctDelta);
          widths[i] = Math.round(newW * 100) / 100;
          widths[i + 1] = Math.round(newNext * 100) / 100;
          applyWidths();
          raf = null;
        });
      }
      function onUp() {
        handle.classList.remove('active');
        document.body.classList.remove('col-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (raf) { cancelAnimationFrame(raf); raf = null; }
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    handle.addEventListener('dblclick', () => {
      widths = [...defaultWidths];
      applyWidths();
    });
  });
}

// --------------------------------------------------------------------------
// Docker events — replaces polling
// --------------------------------------------------------------------------
function startEventStream() {
  stopEventStream();
  state.eventUnsub = window.api.events.onData((evt) => {
    if (evt.Type === 'container' || evt.Type === 'image') {
      refreshActive();
    }
  });
  state.eventEndUnsub = window.api.events.onEnd(() => {
    setTimeout(() => startEventStream(), 3000);
  });
  window.api.events.start();
}

function stopEventStream() {
  if (state.eventUnsub) { state.eventUnsub(); state.eventUnsub = null; }
  if (state.eventEndUnsub) { state.eventEndUnsub(); state.eventEndUnsub = null; }
  window.api.events.stop();
}

// --------------------------------------------------------------------------
// Colima status + profile switching
// --------------------------------------------------------------------------
async function refreshColima() {
  const res = await window.api.colima.list();
  const statusEl = $('#colima-status');
  const specsEl = $('#colima-specs');
  const profileSelect = $('#colima-profile');

  if (!res.ok) {
    statusEl.textContent = 'error';
    statusEl.className = 'status status-unknown';
    showError(res.error);
    return false;
  }
  showError('');

  const currentVal = profileSelect.value;
  const profileNames = res.profiles.map((p) => p.name);
  if (profileNames.length && profileNames.join(',') !== Array.from(profileSelect.options).map((o) => o.value).join(',')) {
    profileSelect.innerHTML = '';
    for (const name of profileNames) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      profileSelect.appendChild(opt);
    }
    if (profileNames.includes(currentVal)) profileSelect.value = currentVal;
  }

  const selected = profileSelect.value;
  const profile = res.profiles.find((p) => p.name === selected) || res.profiles[0];
  if (!profile) {
    statusEl.textContent = 'no profile';
    statusEl.className = 'status status-stopped';
    specsEl.textContent = '';
    return false;
  }

  const running = String(profile.status).toLowerCase() === 'running';
  statusEl.textContent = profile.status;
  statusEl.className = `status ${running ? 'status-running' : 'status-stopped'}`;
  specsEl.innerHTML = running
    ? `<span>${profile.cpus} CPU</span><span>${humanSize(profile.memory)} RAM</span><span>${profile.runtime}</span>`
    : '';
  $('#btn-colima-start').disabled = running;
  $('#btn-colima-stop').disabled = !running;

  if (running) startEventStream();
  else stopEventStream();

  return running;
}

$('#colima-profile').addEventListener('change', async () => {
  const profile = $('#colima-profile').value;
  await window.api.colima.setProfile(profile);
  stopEventStream();
  await refreshActive();
});

// --------------------------------------------------------------------------
// Containers
// --------------------------------------------------------------------------
function stopAllStatsTimers() {
  for (const timer of state.statsTimers.values()) clearInterval(timer);
  state.statsTimers.clear();
}

async function fetchStats(id) {
  const cell = document.querySelector(`[data-stats-id="${id}"]`);
  if (!cell) return;
  const res = await window.api.container.stats(id);
  if (!res.ok) { cell.textContent = '—'; return; }
  const normalize = localStorage.getItem('cpu-display') !== 'raw';
  const cpu = normalize ? res.cpu / (res.cpuCount || 1) : res.cpu;
  cell.innerHTML = `<div class="stat-row"><svg class="stat-icon" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="5.5" y="5.5" width="2" height="2" rx=".4" fill="currentColor"/><rect x="8.5" y="5.5" width="2" height="2" rx=".4" fill="currentColor"/><rect x="5.5" y="8.5" width="2" height="2" rx=".4" fill="currentColor"/><rect x="8.5" y="8.5" width="2" height="2" rx=".4" fill="currentColor"/><line x1="1" y1="6" x2="3" y2="6" stroke="currentColor" stroke-width="1.2"/><line x1="1" y1="10" x2="3" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="13" y1="6" x2="15" y2="6" stroke="currentColor" stroke-width="1.2"/><line x1="13" y1="10" x2="15" y2="10" stroke="currentColor" stroke-width="1.2"/></svg><span class="stat-cpu">${cpu.toFixed(1)}%</span></div><div class="stat-row"><svg class="stat-icon" viewBox="0 0 16 16"><rect x="2" y="4" width="12" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="4" y="6" width="2.5" height="4" rx=".5" fill="currentColor"/><line x1="8" y1="6" x2="8" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="6" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/></svg><span class="stat-mem">${humanSize(res.memUsage)} / ${humanSize(res.memLimit)}</span></div>`;
}

async function refreshContainers() {
  stopAllStatsTimers();
  const res = await window.api.docker.containers();
  const body = $('#containers-body');
  const empty = $('#containers-empty');
  body.innerHTML = '';
  if (!res.ok) { showError(res.error); empty.classList.add('hidden'); return; }
  showError('');
  if (!res.containers.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  for (const c of res.containers) {
    const running = c.state === 'running';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="dot ${running ? 'dot-running' : 'dot-stopped'}"></span>${c.state}</td>
      <td class="col-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td>
      <td class="mono col-image" title="${escapeHtml(c.image)}">${escapeHtml(c.image)}</td>
      <td class="stats-cell col-stats" data-stats-id="${c.id}">${running ? '<span class="muted">…</span>' : '—'}</td>
      <td class="ports col-ports" title="${c.ports.join('\n') || ''}">${c.ports.join('<br>') || '—'}</td>
      <td class="muted col-status">${escapeHtml(c.status)}</td>
      <td class="col-actions"><div class="actions"></div></td>`;
    const actions = tr.querySelector('.actions');

    if (running) {
      actions.appendChild(mkBtn('Stop', 'btn btn-red btn-sm', () => act('stop', c.id)));
      actions.appendChild(mkBtn('Restart', 'btn btn-ghost btn-sm', () => act('restart', c.id)));
    } else {
      actions.appendChild(mkBtn('Start', 'btn btn-green btn-sm', () => act('start', c.id)));
      actions.appendChild(mkBtn('Remove', 'btn btn-red btn-sm', () => removeContainer(c.id, c.name)));
    }

    const menuItems = [];
    menuItems.push({ label: 'Logs', icon: 'logs', action: () => openLogs(c.id, c.name) });
    if (running) menuItems.push({ label: 'Shell', icon: 'shell', action: () => openShell(c.id, c.name) });
    menuItems.push({ label: 'Copy docker run', icon: 'command', action: () => showRunCommand(c.id) });
    actions.appendChild(mkContextMenu(menuItems));
    body.appendChild(tr);

    if (running) {
      fetchStats(c.id);
      state.statsTimers.set(c.id, setInterval(() => fetchStats(c.id), getStatsInterval()));
    }
  }
  applyFilter();
}

function buildRunCommand(info) {
  const cfg = info.Config || {};
  const hc = info.HostConfig || {};
  const parts = ['docker run'];

  if (cfg.Hostname) parts.push(`--hostname ${cfg.Hostname}`);
  const name = (info.Name || '').replace(/^\//, '');
  if (name) parts.push(`--name ${name}`);

  if (hc.RestartPolicy && hc.RestartPolicy.Name && hc.RestartPolicy.Name !== 'no') {
    parts.push(`--restart ${hc.RestartPolicy.Name}${hc.RestartPolicy.MaximumRetryCount ? `:${hc.RestartPolicy.MaximumRetryCount}` : ''}`);
  }

  const portBindings = hc.PortBindings || {};
  for (const [containerPort, bindings] of Object.entries(portBindings)) {
    if (!bindings) continue;
    for (const b of bindings) {
      const hp = b.HostPort || '';
      const hip = b.HostIp && b.HostIp !== '0.0.0.0' ? `${b.HostIp}:` : '';
      parts.push(`-p ${hip}${hp}:${containerPort.replace('/tcp', '')}`);
    }
  }

  for (const env of (cfg.Env || [])) {
    parts.push(`-e "${env}"`);
  }

  const mounts = hc.Binds || [];
  for (const m of mounts) parts.push(`-v ${m}`);

  const nw = info.NetworkSettings && info.NetworkSettings.Networks;
  if (nw) {
    const nets = Object.keys(nw).filter((n) => n !== 'bridge');
    for (const n of nets) parts.push(`--network ${n}`);
  }

  if (hc.Memory && hc.Memory > 0) parts.push(`-m ${Math.round(hc.Memory / 1024 / 1024)}m`);
  if (hc.NanoCpus && hc.NanoCpus > 0) parts.push(`--cpus ${(hc.NanoCpus / 1e9).toFixed(2)}`);

  if (cfg.WorkingDir) parts.push(`-w ${cfg.WorkingDir}`);
  if (cfg.User) parts.push(`-u ${cfg.User}`);

  for (const lbl of Object.entries(cfg.Labels || {})) {
    if (!lbl[0].startsWith('com.docker.')) parts.push(`-l "${lbl[0]}=${lbl[1]}"`);
  }

  parts.push(cfg.Image || '');

  const cmd = cfg.Cmd || [];
  if (cmd.length) parts.push(cmd.join(' '));

  return parts.join(' \\\n  ');
}

async function showRunCommand(id) {
  const res = await window.api.container.inspect(id);
  if (!res.ok) { showError(res.error); return; }
  const cmd = buildRunCommand(res.info);

  const overlay = document.getElementById('command-overlay');
  document.getElementById('command-output').textContent = cmd;
  overlay.classList.remove('hidden');
}

async function act(action, id) {
  const res = await window.api.container[action](id);
  if (!res.ok) showError(res.error);
  await refreshContainers();
}

async function removeContainer(id, name) {
  if (!confirm(`Remove container "${name}"? This cannot be undone.`)) return;
  const res = await window.api.container.remove(id, true);
  if (!res.ok) showError(res.error);
  await refreshContainers();
}

// --------------------------------------------------------------------------
// Images
// --------------------------------------------------------------------------
async function refreshImages() {
  const res = await window.api.docker.images();
  const body = $('#images-body');
  const empty = $('#images-empty');
  body.innerHTML = '';
  if (!res.ok) { showError(res.error); return; }
  showError('');
  if (!res.images.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  for (const img of res.images) {
    for (const tag of img.tags) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">${escapeHtml(tag)}</td>
        <td class="mono muted">${img.id}</td>
        <td>${humanSize(img.size)}</td>
        <td class="col-actions"><div class="actions"></div></td>`;
      const actions = tr.querySelector('.actions');
      actions.appendChild(mkContextMenu([
        { label: 'Remove', icon: 'remove', danger: true, action: () => removeImage(img.id, tag) },
      ]));
      body.appendChild(tr);
    }
  }
  applyFilter();
}

async function removeImage(id, tag) {
  if (!confirm(`Remove image "${tag}"?`)) return;
  const res = await window.api.image.remove(id, true);
  if (!res.ok) showError(res.error);
  await refreshImages();
}

async function pruneImages() {
  if (!confirm('Remove all dangling (unused) images?')) return;
  const res = await window.api.image.prune();
  if (!res.ok) { showError(res.error); return; }
  showError('');
  const msg = `Pruned — reclaimed ${humanSize(res.reclaimed)}`;
  const el = $('#global-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.style.borderColor = 'var(--green)';
  el.style.background = 'rgba(46,160,67,0.12)';
  el.style.color = '#7ee787';
  setTimeout(() => {
    el.classList.add('hidden');
    el.removeAttribute('style');
  }, 4000);
  await refreshImages();
}

// --------------------------------------------------------------------------
// Volumes
// --------------------------------------------------------------------------
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function refreshVolumes() {
  const res = await window.api.volume.list();
  const body = $('#volumes-body');
  const empty = $('#volumes-empty');
  body.innerHTML = '';
  if (!res.ok) { showError(res.error); empty.classList.add('hidden'); return; }
  showError('');
  if (!res.volumes.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  for (const v of res.volumes) {
    const tr = document.createElement('tr');
    const shortName = v.name.length > 40 ? v.name.slice(0, 37) + '…' : v.name;
    tr.innerHTML = `
      <td class="mono" title="${escapeHtml(v.name)}">${escapeHtml(shortName)}</td>
      <td class="muted">${escapeHtml(v.driver)}</td>
      <td class="muted">${formatDate(v.created)}</td>
      <td class="col-actions"><div class="actions"></div></td>`;
    const actions = tr.querySelector('.actions');
    actions.appendChild(mkContextMenu([
      { label: 'Inspect', icon: 'command', action: () => inspectVolume(v.name) },
      { separator: true },
      { label: 'Remove', icon: 'remove', danger: true, action: () => removeVolume(v.name) },
    ]));
    body.appendChild(tr);
  }
  applyFilter();
}

async function inspectVolume(name) {
  const res = await window.api.volume.inspect(name);
  if (!res.ok) { showError(res.error); return; }
  const overlay = document.getElementById('command-overlay');
  document.querySelector('.modal-title').textContent = `Volume — ${name}`;
  document.getElementById('command-output').textContent = JSON.stringify(res.info, null, 2);
  overlay.classList.remove('hidden');
}

async function removeVolume(name) {
  if (!confirm(`Remove volume "${name}"? Data will be lost.`)) return;
  const res = await window.api.volume.remove(name);
  if (!res.ok) showError(res.error);
  await refreshVolumes();
}

async function pruneVolumes() {
  if (!confirm('Remove all unused volumes? Data will be lost.')) return;
  const res = await window.api.volume.prune();
  if (!res.ok) { showError(res.error); return; }
  showError('');
  const msg = `Pruned ${res.count} volume(s) — reclaimed ${humanSize(res.reclaimed)}`;
  const el = $('#global-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.style.borderColor = 'var(--green)';
  el.style.background = 'rgba(46,160,67,0.12)';
  el.style.color = '#7ee787';
  setTimeout(() => {
    el.classList.add('hidden');
    el.removeAttribute('style');
  }, 4000);
  await refreshVolumes();
}

// --------------------------------------------------------------------------
// Compose
// --------------------------------------------------------------------------
const composeCollapsed = new Set(JSON.parse(localStorage.getItem('compose-collapsed') || '[]'));

function saveComposeCollapsed() {
  localStorage.setItem('compose-collapsed', JSON.stringify([...composeCollapsed]));
}

async function refreshCompose() {
  stopAllStatsTimers();
  const res = await window.api.docker.containers();
  const body = $('#compose-body');
  const empty = $('#compose-empty');
  body.innerHTML = '';
  if (!res.ok) { showError(res.error); empty.classList.add('hidden'); return; }
  showError('');

  // Group by compose project
  const projects = new Map();
  for (const c of res.containers) {
    if (!c.composeProject) continue;
    if (!projects.has(c.composeProject)) projects.set(c.composeProject, []);
    projects.get(c.composeProject).push(c);
  }

  if (!projects.size) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  for (const [project, services] of [...projects.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    services.sort((a, b) => (a.composeService || '').localeCompare(b.composeService || ''));
    const runningCount = services.filter((s) => s.state === 'running').length;
    const allRunning = runningCount === services.length;
    const collapsed = composeCollapsed.has(project);
    const workdir = services.find((s) => s.composeWorkdir)?.composeWorkdir || '';

    const group = document.createElement('div');
    group.className = 'compose-group';

    const header = document.createElement('div');
    header.className = 'compose-header';
    header.innerHTML = `
      <div class="compose-header-left">
        <svg class="compose-caret ${collapsed ? 'collapsed' : ''}" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="compose-name">${escapeHtml(project)}</span>
        <span class="compose-badge ${allRunning ? 'badge-running' : runningCount ? 'badge-partial' : 'badge-stopped'}">${runningCount}/${services.length} running</span>
      </div>
      <div class="compose-actions"></div>`;
    if (workdir) header.title = workdir;

    const headerActions = header.querySelector('.compose-actions');
    headerActions.appendChild(mkBtn('Start', 'btn btn-green btn-sm', () => composeBulk(services, 'start')));
    headerActions.appendChild(mkBtn('Stop', 'btn btn-red btn-sm', () => composeBulk(services, 'stop')));
    headerActions.appendChild(mkBtn('Restart', 'btn btn-ghost btn-sm', () => composeBulk(services, 'restart')));

    header.querySelector('.compose-header-left').addEventListener('click', (e) => {
      // ignore clicks on action buttons
      if (e.target.closest('.compose-actions')) return;
      if (composeCollapsed.has(project)) composeCollapsed.delete(project);
      else composeCollapsed.add(project);
      saveComposeCollapsed();
      refreshCompose();
    });

    group.appendChild(header);

    if (!collapsed) {
      const table = document.createElement('table');
      table.className = 'grid compose-services';
      table.innerHTML = `<tbody></tbody>`;
      const tbody = table.querySelector('tbody');
      for (const c of services) {
        const running = c.state === 'running';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="compose-svc-state"><span class="dot ${running ? 'dot-running' : 'dot-stopped'}"></span></td>
          <td class="compose-svc-name">${escapeHtml(c.composeService || c.name)}</td>
          <td class="mono muted compose-svc-image" title="${escapeHtml(c.image)}">${escapeHtml(c.image)}</td>
          <td class="ports compose-svc-ports">${c.ports.join(', ') || '—'}</td>
          <td class="muted compose-svc-status">${escapeHtml(c.status)}</td>
          <td class="col-actions"><div class="actions"></div></td>`;
        const actions = tr.querySelector('.actions');
        if (running) {
          actions.appendChild(mkBtn('Stop', 'btn btn-red btn-sm', () => act('stop', c.id)));
          actions.appendChild(mkBtn('Restart', 'btn btn-ghost btn-sm', () => act('restart', c.id)));
        } else {
          actions.appendChild(mkBtn('Start', 'btn btn-green btn-sm', () => act('start', c.id)));
        }
        const menuItems = [{ label: 'Logs', icon: 'logs', action: () => openLogs(c.id, c.name) }];
        if (running) menuItems.push({ label: 'Shell', icon: 'shell', action: () => openShell(c.id, c.name) });
        menuItems.push({ label: 'Copy docker run', icon: 'command', action: () => showRunCommand(c.id) });
        actions.appendChild(mkContextMenu(menuItems));
        tbody.appendChild(tr);
      }
      group.appendChild(table);
    }

    body.appendChild(group);
  }

  applyFilter();
}

async function composeBulk(services, action) {
  const targets = services.filter((s) => {
    if (action === 'start') return s.state !== 'running';
    if (action === 'stop') return s.state === 'running';
    return true; // restart all
  });
  for (const c of targets) {
    const res = await window.api.container[action](c.id);
    if (!res.ok) showError(res.error);
  }
  await refreshCompose();
}

// --------------------------------------------------------------------------
// Networks
// --------------------------------------------------------------------------
async function refreshNetworks() {
  const res = await window.api.network.list();
  const body = $('#networks-body');
  const empty = $('#networks-empty');
  body.innerHTML = '';
  if (!res.ok) { showError(res.error); empty.classList.add('hidden'); return; }
  showError('');
  if (!res.networks.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  for (const n of res.networks) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono" title="${escapeHtml(n.name)}">${escapeHtml(n.name)}${n.builtin ? ' <span class="net-builtin">built-in</span>' : ''}</td>
      <td class="muted">${escapeHtml(n.driver)}</td>
      <td class="muted">${escapeHtml(n.scope)}</td>
      <td class="mono muted">${escapeHtml(n.ipam || '—')}</td>
      <td class="muted">${n.containerCount == null ? '—' : n.containerCount}</td>
      <td class="col-actions"><div class="actions"></div></td>`;
    const actions = tr.querySelector('.actions');
    const menuItems = [{ label: 'Inspect', icon: 'command', action: () => inspectNetwork(n.id) }];
    if (!n.builtin) {
      menuItems.push({ separator: true });
      menuItems.push({ label: 'Remove', icon: 'remove', danger: true, action: () => removeNetwork(n.id, n.name) });
    }
    actions.appendChild(mkContextMenu(menuItems));
    body.appendChild(tr);
  }
  applyFilter();
}

async function inspectNetwork(id) {
  const res = await window.api.network.inspect(id);
  if (!res.ok) { showError(res.error); return; }
  const overlay = document.getElementById('command-overlay');
  document.querySelector('.modal-title').textContent = `Network — ${res.info.Name}`;
  document.getElementById('command-output').textContent = JSON.stringify(res.info, null, 2);
  overlay.classList.remove('hidden');
}

async function removeNetwork(id, name) {
  if (!confirm(`Remove network "${name}"?`)) return;
  const res = await window.api.network.remove(id);
  if (!res.ok) showError(res.error);
  await refreshNetworks();
}

async function pruneNetworks() {
  if (!confirm('Remove all unused networks?')) return;
  const res = await window.api.network.prune();
  if (!res.ok) { showError(res.error); return; }
  showError('');
  const el = $('#global-error');
  el.textContent = `Pruned ${res.count} network(s)`;
  el.classList.remove('hidden');
  el.style.borderColor = 'var(--green)';
  el.style.background = 'rgba(46,160,67,0.12)';
  el.style.color = '#7ee787';
  setTimeout(() => { el.classList.add('hidden'); el.removeAttribute('style'); }, 4000);
  await refreshNetworks();
}

// --------------------------------------------------------------------------
// Logs drawer
// --------------------------------------------------------------------------
// Logs render through a read-only xterm instance: ANSI colors from the app
// render natively, scrollback is capped by the terminal (bounded memory), and
// canvas rendering stays fast under a firehose. We line-buffer incoming chunks
// so level-based highlighting works on whole lines.
let logsTerm = null;
let logsFit = null;
let logsPartial = '';

// ANSI color helpers
const ANSI = { reset: '\x1b[0m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', dim: '\x1b[90m', boldRed: '\x1b[1;31m' };

function ensureLogsTerm() {
  if (logsTerm) return;
  logsTerm = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
    cursorBlink: false,
    disableStdin: true,
    convertEol: true,
    scrollback: 10000,
    theme: termTheme(),
  });
  logsFit = new FitAddon.FitAddon();
  logsTerm.loadAddon(logsFit);
  logsTerm.open($('#logs-output'));
}

// Highlight common log levels / timestamps when the app didn't emit its own
// ANSI. If a line already contains an escape sequence, leave it untouched.
function colorizeLine(line, stream) {
  if (line.indexOf('\x1b') !== -1) return line; // app already colored it
  let out = line;
  // ISO-ish timestamps and [bracketed] times → dim
  out = out.replace(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/g, `${ANSI.dim}$1${ANSI.reset}`);
  // Level keywords
  out = out.replace(/\b(ERROR|FATAL|SEVERE|PANIC)\b/g, `${ANSI.boldRed}$1${ANSI.reset}`);
  out = out.replace(/\b(WARN(?:ING)?)\b/g, `${ANSI.yellow}$1${ANSI.reset}`);
  out = out.replace(/\b(INFO|NOTICE)\b/g, `${ANSI.green}$1${ANSI.reset}`);
  out = out.replace(/\b(DEBUG|TRACE)\b/g, `${ANSI.cyan}$1${ANSI.reset}`);
  if (stream === 'stderr' && out === line) out = `${ANSI.red}${line}${ANSI.reset}`;
  return out;
}

async function openLogs(id, name) {
  closeLogsStream();
  state.currentLogId = id;
  $('#logs-title').textContent = `Logs · ${name}`;
  $('#logs-drawer').classList.remove('hidden');

  ensureLogsTerm();
  logsTerm.options.theme = termTheme();
  logsTerm.reset();
  logsPartial = '';
  await new Promise((r) => requestAnimationFrame(r));
  try { logsFit.fit(); } catch (_) { /* noop */ }

  state.logUnsub = window.api.logs.onData((p) => {
    if (p.id !== state.currentLogId) return;
    appendLog(p.line, p.stream);
  });
  state.endUnsub = window.api.logs.onEnd((p) => {
    if (p.error) appendLog(`\n[stream ended: ${p.error}]\n`, 'stderr');
  });

  const res = await window.api.logs.start(id);
  if (!res.ok) appendLog(`[failed to attach logs: ${res.error}]\n`, 'stderr');
}

function appendLog(text, stream) {
  if (!logsTerm) return;
  // Line-buffer so colorization sees whole lines; hold the trailing partial.
  const combined = logsPartial + text;
  const parts = combined.split('\n');
  logsPartial = parts.pop(); // last piece is incomplete (no newline yet)
  for (const line of parts) {
    logsTerm.write(colorizeLine(line, stream) + '\r\n');
  }
  if ($('#logs-follow').checked) logsTerm.scrollToBottom();
}

function clearLogs() {
  if (logsTerm) logsTerm.clear();
  logsPartial = '';
}

function fitLogs() {
  if (logsFit && logsTerm && !$('#logs-drawer').classList.contains('hidden')) {
    try { logsFit.fit(); } catch (_) { /* noop */ }
  }
}

function closeLogsStream() {
  if (state.logUnsub) { state.logUnsub(); state.logUnsub = null; }
  if (state.endUnsub) { state.endUnsub(); state.endUnsub = null; }
  window.api.logs.stop();
  state.currentLogId = null;
}

// --------------------------------------------------------------------------
// Config modal
// --------------------------------------------------------------------------
let configRaw = '';
let configParsed = {};
let configAdvanced = false;

function showConfigError(msg) {
  const el = $('#config-error');
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = msg;
  el.classList.remove('hidden');
}

function populateFormFromParsed(p) {
  $('#cfg-cpu').value = p.cpu || 2;
  $('#cfg-memory').value = p.memory || 2;
  $('#cfg-disk').value = p.disk || 60;
  $('#cfg-runtime').value = p.runtime || 'docker';
  $('#cfg-kubernetes').value = String(!!p.kubernetes?.enabled);
  $('#cfg-vmtype').value = p.vmType || 'qemu';
}

function applyFormToParsed(p) {
  p.cpu = parseInt($('#cfg-cpu').value, 10) || 2;
  p.memory = parseInt($('#cfg-memory').value, 10) || 2;
  p.disk = parseInt($('#cfg-disk').value, 10) || 60;
  p.runtime = $('#cfg-runtime').value;
  if (!p.kubernetes) p.kubernetes = {};
  p.kubernetes.enabled = $('#cfg-kubernetes').value === 'true';
  p.vmType = $('#cfg-vmtype').value;
  return p;
}

function getStatsInterval() {
  return (parseInt(localStorage.getItem('stats-interval'), 10) || 5) * 1000;
}

function loadGuiSettings() {
  $('#cfg-cpu-normalize').value = localStorage.getItem('cpu-display') || 'normalized';
  $('#cfg-stats-interval').value = localStorage.getItem('stats-interval') || '5';
}

function saveGuiSettings() {
  localStorage.setItem('cpu-display', $('#cfg-cpu-normalize').value);
  localStorage.setItem('stats-interval', $('#cfg-stats-interval').value);
}

async function openConfig() {
  showConfigError('');
  const profile = $('#colima-profile').value;
  const res = await window.api.config.read(profile);
  if (!res.ok) { showConfigError(res.error); $('#config-overlay').classList.remove('hidden'); return; }

  configRaw = res.raw;
  configParsed = res.parsed;
  $('#config-path').textContent = res.path;
  populateFormFromParsed(configParsed);
  loadGuiSettings();
  $('#cfg-raw').value = configRaw;

  configAdvanced = false;
  $('#config-form-view').classList.remove('hidden');
  $('#config-advanced-view').classList.add('hidden');
  $('#config-toggle-advanced').textContent = 'Advanced';

  $('#config-overlay').classList.remove('hidden');
}

function closeConfig() {
  $('#config-overlay').classList.add('hidden');
  showConfigError('');
}

function toggleAdvanced() {
  configAdvanced = !configAdvanced;
  if (configAdvanced) {
    $('#config-form-view').classList.add('hidden');
    $('#config-advanced-view').classList.remove('hidden');
    $('#config-toggle-advanced').textContent = 'Simple';
  } else {
    $('#config-form-view').classList.remove('hidden');
    $('#config-advanced-view').classList.add('hidden');
    $('#config-toggle-advanced').textContent = 'Advanced';
  }
}

async function saveConfig(restart) {
  showConfigError('');
  const profile = $('#colima-profile').value;
  let content;

  if (configAdvanced) {
    content = $('#cfg-raw').value;
  } else {
    content = applyFormToParsed({ ...configParsed });
  }

  saveGuiSettings();

  const res = await window.api.config.write(profile, content);
  if (!res.ok) { showConfigError(res.error); return; }

  closeConfig();
  stopAllStatsTimers();

  if (restart) {
    $('#colima-status').textContent = 'stopping…';
    const stopRes = await window.api.colima.stop(profile);
    if (!stopRes.ok) { showError(stopRes.error); return; }
    $('#colima-status').textContent = 'starting…';
    const startRes = await window.api.colima.start(profile);
    if (!startRes.ok) { showError(startRes.error); return; }
  }

  await refreshActive();
}

$('#command-close').addEventListener('click', () => $('#command-overlay').classList.add('hidden'));
$('#command-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('#command-overlay').classList.add('hidden');
});
$('#command-copy').addEventListener('click', () => {
  navigator.clipboard.writeText($('#command-output').textContent);
  const btn = $('#command-copy');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
});

// --------------------------------------------------------------------------
// Shell — real terminal via xterm.js
// --------------------------------------------------------------------------
let shellTerm = null;
let shellFit = null;
let shellInputDisposable = null;
let shellCleanup = { data: null, end: null };
let shellContainerId = null;

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  return {
    background: v('--logs-bg') || '#0b0e13',
    foreground: v('--text') || '#e6edf3',
    cursor: v('--blue') || '#388bfd',
    selectionBackground: 'rgba(56,139,253,0.3)',
  };
}

function ensureTerm() {
  if (shellTerm) return;
  shellTerm = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
    cursorBlink: true,
    theme: termTheme(),
    scrollback: 5000,
  });
  shellFit = new FitAddon.FitAddon();
  shellTerm.loadAddon(shellFit);
  shellTerm.open($('#shell-terminal'));
}

function fitAndResize() {
  if (!shellFit || !shellTerm) return;
  try { shellFit.fit(); } catch (_) { /* noop */ }
  window.api.exec.resize(shellTerm.cols, shellTerm.rows);
}

function closeShell() {
  window.api.exec.stop();
  if (shellCleanup.data) shellCleanup.data();
  if (shellCleanup.end) shellCleanup.end();
  if (shellInputDisposable) { shellInputDisposable.dispose(); shellInputDisposable = null; }
  shellCleanup = { data: null, end: null };
  shellContainerId = null;
  $('#shell-overlay').classList.add('hidden');
}

async function openShell(id, name) {
  // tear down any prior session but keep the terminal instance
  window.api.exec.stop();
  if (shellCleanup.data) shellCleanup.data();
  if (shellCleanup.end) shellCleanup.end();
  if (shellInputDisposable) { shellInputDisposable.dispose(); shellInputDisposable = null; }
  shellCleanup = { data: null, end: null };

  shellContainerId = id;
  $('#shell-title').textContent = `Shell — ${name}`;
  $('#shell-overlay').classList.remove('hidden');

  ensureTerm();
  shellTerm.options.theme = termTheme();
  shellTerm.reset();
  // wait a frame so the now-visible container has layout, then size to fit
  await new Promise((r) => requestAnimationFrame(r));
  try { shellFit.fit(); } catch (_) { /* noop */ }
  shellTerm.focus();

  const shell = $('#shell-select').value;
  const res = await window.api.exec.start(id, shell, { cols: shellTerm.cols, rows: shellTerm.rows });
  if (!res.ok) {
    shellTerm.write(`\r\n\x1b[31mError: ${res.error}\x1b[0m\r\n`);
    return;
  }

  // keystrokes → container
  shellInputDisposable = shellTerm.onData((data) => window.api.exec.write(data));
  // container → terminal
  shellCleanup.data = window.api.exec.onData((text) => shellTerm.write(text));
  shellCleanup.end = window.api.exec.onEnd((payload) => {
    if (payload && payload.error) shellTerm.write(`\r\n\x1b[31mSession ended: ${payload.error}\x1b[0m\r\n`);
    else shellTerm.write('\r\n\x1b[90m--- session ended ---\x1b[0m\r\n');
  });
}

$('#shell-close').addEventListener('click', closeShell);
$('#shell-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeShell();
});

$('#shell-select').addEventListener('change', () => {
  if (shellContainerId) {
    const name = $('#shell-title').textContent.replace('Shell — ', '');
    openShell(shellContainerId, name);
  }
});

window.addEventListener('resize', () => {
  if (!$('#shell-overlay').classList.contains('hidden')) fitAndResize();
  fitLogs();
});

$('#btn-config').addEventListener('click', openConfig);
$('#config-close').addEventListener('click', closeConfig);
$('#config-toggle-advanced').addEventListener('click', toggleAdvanced);
$('#config-save').addEventListener('click', async () => {
  const btn = $('#config-save');
  btn.classList.add('loading');
  try { await saveConfig(true); } finally { btn.classList.remove('loading'); }
});
$('#config-save-only').addEventListener('click', async () => {
  const btn = $('#config-save-only');
  btn.classList.add('loading');
  try { await saveConfig(false); } finally { btn.classList.remove('loading'); }
});
$('#config-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeConfig();
});

// --------------------------------------------------------------------------
// Resizable logs drawer
// --------------------------------------------------------------------------
(function initDrawerResize() {
  const handle = document.getElementById('drawer-resize');
  const drawer = document.getElementById('logs-drawer');
  if (!handle || !drawer) return;

  const MIN_H = 120;
  const MAX_RATIO = 0.85;

  const savedH = localStorage.getItem('drawer-height');
  if (savedH) drawer.style.height = savedH + 'px';

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('drawer-resizing');
    const startY = e.clientY;
    const startH = drawer.offsetHeight;
    let raf = null;

    function onMove(ev) {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        const dy = startY - ev.clientY;
        const newH = Math.max(MIN_H, Math.min(window.innerHeight * MAX_RATIO, startH + dy));
        drawer.style.height = newH + 'px';
        fitLogs();
        raf = null;
      });
    }
    function onUp() {
      document.body.classList.remove('drawer-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      localStorage.setItem('drawer-height', drawer.offsetHeight);
      fitLogs();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  handle.addEventListener('dblclick', () => {
    drawer.style.height = '55vh';
    localStorage.removeItem('drawer-height');
    fitLogs();
  });
})();

// --------------------------------------------------------------------------
// Helpers + wiring
// --------------------------------------------------------------------------
const ICONS = {
  logs: '<svg viewBox="0 0 16 16" class="btn-icon"><path d="M3 1h7l3 3v11H3V1z" fill="none" stroke="currentColor" stroke-width="1.3"/><line x1="5" y1="7" x2="11" y2="7" stroke="currentColor" stroke-width="1.2"/><line x1="5" y1="9.5" x2="11" y2="9.5" stroke="currentColor" stroke-width="1.2"/><line x1="5" y1="12" x2="9" y2="12" stroke="currentColor" stroke-width="1.2"/></svg>',
  stop: '<svg viewBox="0 0 16 16" class="btn-icon"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/></svg>',
  start: '<svg viewBox="0 0 16 16" class="btn-icon"><polygon points="4,2 14,8 4,14" fill="currentColor"/></svg>',
  restart: '<svg viewBox="0 0 16 16" class="btn-icon"><path d="M2.5 8a5.5 5.5 0 0 1 9.9-3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13.5 8a5.5 5.5 0 0 1-9.9 3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M12.4 1.5v3.3h-3.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.6 14.5v-3.3h3.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  remove: '<svg viewBox="0 0 16 16" class="btn-icon"><path d="M5 3V2h6v1M2 4h12M4 4l1 10h6l1-10" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  command: '<svg viewBox="0 0 16 16" class="btn-icon"><path d="M4 1h6l3 3v11H4V1z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.5 7l-2 2 2 2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.5 7l2 2-2 2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  shell: '<svg viewBox="0 0 16 16" class="btn-icon"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 6l2 1.5-2 1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><line x1="8.5" y1="10" x2="11.5" y2="10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
};

function mkBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  const icon = ICONS[label.toLowerCase()];
  if (icon) {
    b.innerHTML = icon;
    b.title = label;
  } else {
    b.textContent = label;
  }
  b.addEventListener('click', async () => {
    b.classList.add('loading');
    try { await onClick(); }
    finally { b.classList.remove('loading'); }
  });
  return b;
}

function mkContextMenu(items) {
  const wrap = document.createElement('div');
  wrap.className = 'ctx-menu-wrap';

  const trigger = document.createElement('button');
  trigger.className = 'btn btn-ghost btn-sm ctx-trigger';
  trigger.innerHTML = '<svg viewBox="0 0 16 16" class="btn-icon"><circle cx="8" cy="3" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="13" r="1.3" fill="currentColor"/></svg>';
  trigger.title = 'Actions';

  const menu = document.createElement('div');
  menu.className = 'ctx-menu hidden';

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('button');
    row.className = 'ctx-item' + (item.danger ? ' ctx-danger' : '');
    const iconHtml = ICONS[item.icon] ? `<span class="ctx-icon">${ICONS[item.icon]}</span>` : '';
    row.innerHTML = `${iconHtml}<span>${item.label}</span>`;
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      menu.classList.add('hidden');
      row.classList.add('loading');
      try { await item.action(); }
      finally { row.classList.remove('loading'); }
    });
    menu.appendChild(row);
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus();
    const wasHidden = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    if (wasHidden) {
      const r = trigger.getBoundingClientRect();
      menu.style.top = (r.bottom + 4) + 'px';
      menu.style.right = (window.innerWidth - r.right) + 'px';
      menu.style.left = 'auto';
      requestAnimationFrame(() => {
        const mr = menu.getBoundingClientRect();
        if (mr.bottom > window.innerHeight) {
          menu.style.top = (r.top - mr.height - 4) + 'px';
        }
      });
    }
  });

  document.body.appendChild(menu);
  wrap.appendChild(trigger);
  return wrap;
}

function closeAllMenus() {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.classList.add('hidden'));
}
document.addEventListener('click', closeAllMenus);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function switchTab(tab) {
  state.tab = tab;
  $$('.nav-item[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#view-containers').classList.toggle('hidden', tab !== 'containers');
  $('#view-images').classList.toggle('hidden', tab !== 'images');
  $('#view-volumes').classList.toggle('hidden', tab !== 'volumes');
  $('#view-compose').classList.toggle('hidden', tab !== 'compose');
  $('#view-networks').classList.toggle('hidden', tab !== 'networks');
  refreshActive();
}

let refreshDebounce = null;
async function refreshActive() {
  if (refreshDebounce) return;
  refreshDebounce = setTimeout(() => { refreshDebounce = null; }, 500);
  const running = await refreshColima();
  if (!running) return;
  if (state.tab === 'containers') await refreshContainers();
  else if (state.tab === 'images') await refreshImages();
  else if (state.tab === 'volumes') await refreshVolumes();
  else if (state.tab === 'compose') await refreshCompose();
  else if (state.tab === 'networks') await refreshNetworks();
}

// Filter
function applyFilter() {
  const q = $('#filter-input').value.toLowerCase().trim();
  if (state.tab === 'compose') {
    document.querySelectorAll('#compose-body .compose-group').forEach((g) => {
      g.style.display = q && !g.textContent.toLowerCase().includes(q) ? 'none' : '';
    });
    return;
  }
  const bodyMap = { containers: 'containers-body', images: 'images-body', volumes: 'volumes-body', networks: 'networks-body' };
  const bodyId = bodyMap[state.tab] || 'containers-body';
  const rows = Array.from(document.getElementById(bodyId).children);
  for (const tr of rows) {
    const text = tr.textContent.toLowerCase();
    tr.style.display = q && !text.includes(q) ? 'none' : '';
  }
}
$('#filter-input').addEventListener('input', applyFilter);

// Events
$$('.nav-item[data-tab]').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
$('#btn-refresh').addEventListener('click', refreshActive);
$('#btn-prune').addEventListener('click', pruneImages);
$('#btn-prune-volumes').addEventListener('click', pruneVolumes);
$('#btn-prune-networks').addEventListener('click', pruneNetworks);

// Sidebar expand/collapse
$('#sidebar-expand').addEventListener('click', () => {
  $('#app').classList.toggle('sidebar-expanded');
  localStorage.setItem('sidebar-expanded', $('#app').classList.contains('sidebar-expanded') ? '1' : '');
});
if (localStorage.getItem('sidebar-expanded') === '1') {
  $('#app').classList.add('sidebar-expanded');
}
$('#logs-close').addEventListener('click', () => {
  closeLogsStream();
  $('#logs-drawer').classList.add('hidden');
});
$('#logs-clear').addEventListener('click', clearLogs);

$('#btn-colima-start').addEventListener('click', async () => {
  const btn = $('#btn-colima-start');
  btn.classList.add('loading');
  $('#colima-status').textContent = 'starting…';
  try {
    const res = await window.api.colima.start($('#colima-profile').value);
    if (!res.ok) showError(res.error);
    await refreshActive();
  } finally { btn.classList.remove('loading'); }
});
$('#btn-colima-stop').addEventListener('click', async () => {
  const btn = $('#btn-colima-stop');
  btn.classList.add('loading');
  $('#colima-status').textContent = 'stopping…';
  try {
    const res = await window.api.colima.stop($('#colima-profile').value);
    if (!res.ok) showError(res.error);
    await refreshActive();
  } finally { btn.classList.remove('loading'); }
});

// Initial load
initTheme();
makeResizable('containers-table', 'col-widths-containers', [10, 14, 18, 14, 12, 14, 18]);
makeResizable('images-table', 'col-widths-images', [40, 20, 15, 25]);
makeResizable('volumes-table', 'col-widths-volumes', [50, 15, 20, 15]);
makeResizable('networks-table', 'col-widths-networks', [28, 14, 12, 22, 12, 12]);
refreshActive();
setInterval(() => refreshColima(), 15000);
