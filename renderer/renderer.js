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
  colimaLogUnsub: null,
  composeLogUnsub: null,
  composeEndUnsub: null,
  eventUnsub: null,
  eventEndUnsub: null,
  eventReconnectTimer: null,
  eventsDesired: false,
  eventsStarting: false,
  eventsActive: false,
  eventGeneration: 0,
  statsTimers: new Map(),
};

// Container ids with an action in flight → verb ('stopping…' etc). Honored by
// every render so the spinner survives event-driven refreshes that rebuild the
// row mid-action; cleared only when the Docker call actually resolves.
const pendingActions = new Map();
const ACTION_VERB = { start: 'starting…', stop: 'stopping…', restart: 'restarting…' };

let toastTimer = null;
function hideToast() {
  const el = $('#global-error');
  el.classList.add('hidden');
  $('#global-error-text').textContent = '';
  el.removeAttribute('style');
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
}
function showError(msg) {
  if (!msg) { hideToast(); return; }
  const el = $('#global-error');
  el.removeAttribute('style'); // drop any leftover success styling
  $('#global-error-text').textContent = msg;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 8000);
}

// Blocking error dialog the user must acknowledge — used for failures of an
// explicit user action (remove/prune), where a transient toast is too easy to miss.
function showAlert(msg, title = 'Error') {
  $('#alert-title').textContent = title;
  $('#alert-message').textContent = msg;
  $('#alert-overlay').classList.remove('hidden');
  $('#alert-ok').focus();
}
function closeAlert() {
  $('#alert-overlay').classList.add('hidden');
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
function clearEventReconnectTimer() {
  if (state.eventReconnectTimer) {
    clearTimeout(state.eventReconnectTimer);
    state.eventReconnectTimer = null;
  }
}

function teardownEventListeners() {
  if (state.eventUnsub) { state.eventUnsub(); state.eventUnsub = null; }
  if (state.eventEndUnsub) { state.eventEndUnsub(); state.eventEndUnsub = null; }
}

function scheduleEventReconnect() {
  if (!state.eventsDesired || state.eventReconnectTimer) return;
  state.eventReconnectTimer = setTimeout(() => {
    state.eventReconnectTimer = null;
    startEventStream();
  }, 3000);
}

function startEventStream() {
  if (!state.eventsDesired || state.eventsStarting || state.eventsActive) return;
  clearEventReconnectTimer();
  teardownEventListeners();
  const generation = ++state.eventGeneration;
  state.eventsStarting = true;

  state.eventUnsub = window.api.events.onData((evt) => {
    if (evt.Type === 'container' || evt.Type === 'image') {
      refreshActive();
    }
    // Authoritative stop-detection for the open log drawer: a genuine container
    // stop arrives here even if the log follow-stream already died on its own.
    if (evt.Type === 'container' && state.currentLogId) {
      const evtId = evt.id || (evt.Actor && evt.Actor.ID) || '';
      const action = evt.Action || evt.status || '';
      if (evtId.slice(0, 12) === state.currentLogId.slice(0, 12) && /^(die|stop|kill)/.test(action)) {
        markLogsStopped('container stopped — showing final logs');
      }
    }
  });
  state.eventEndUnsub = window.api.events.onEnd(() => {
    if (generation !== state.eventGeneration) return;
    teardownEventListeners();
    state.eventsStarting = false;
    state.eventsActive = false;
    scheduleEventReconnect();
  });

  window.api.events.start()
    .then((res) => {
      if (generation !== state.eventGeneration) return;
      state.eventsStarting = false;
      if (!state.eventsDesired) { stopEventStream(); return; }
      if (res && !res.ok) {
        teardownEventListeners();
        state.eventsActive = false;
        scheduleEventReconnect();
        return;
      }
      state.eventsActive = true;
    })
    .catch(() => {
      if (generation !== state.eventGeneration) return;
      teardownEventListeners();
      state.eventsStarting = false;
      state.eventsActive = false;
      scheduleEventReconnect();
    });
}

function stopEventStream() {
  state.eventsDesired = false;
  state.eventGeneration += 1;
  clearEventReconnectTimer();
  teardownEventListeners();
  state.eventsStarting = false;
  state.eventsActive = false;
  window.api.events.stop();
}

function syncEventStream(shouldRun) {
  if (shouldRun) {
    state.eventsDesired = true;
    startEventStream();
    return;
  }
  if (state.eventsDesired || state.eventsStarting || state.eventsActive || state.eventReconnectTimer || state.eventUnsub || state.eventEndUnsub) {
    stopEventStream();
  }
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
    syncEventStream(false);
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
    syncEventStream(false);
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

  syncEventStream(running);

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

const STAT_CPU_ICON = '<svg class="stat-icon" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="5.5" y="5.5" width="2" height="2" rx=".4" fill="currentColor"/><rect x="8.5" y="5.5" width="2" height="2" rx=".4" fill="currentColor"/><rect x="5.5" y="8.5" width="2" height="2" rx=".4" fill="currentColor"/><rect x="8.5" y="8.5" width="2" height="2" rx=".4" fill="currentColor"/><line x1="1" y1="6" x2="3" y2="6" stroke="currentColor" stroke-width="1.2"/><line x1="1" y1="10" x2="3" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="13" y1="6" x2="15" y2="6" stroke="currentColor" stroke-width="1.2"/><line x1="13" y1="10" x2="15" y2="10" stroke="currentColor" stroke-width="1.2"/></svg>';
const STAT_MEM_ICON = '<svg class="stat-icon" viewBox="0 0 16 16"><rect x="2" y="4" width="12" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="4" y="6" width="2.5" height="4" rx=".5" fill="currentColor"/><line x1="8" y1="6" x2="8" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="6" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/></svg>';

// Two-row markup, matching the populated stats layout, so the placeholder and
// the live values occupy the same height — no row-height jump on refresh.
function statsMarkup(cpuText, memText, cls) {
  const c = cls ? ` ${cls}` : '';
  return `<div class="stat-row">${STAT_CPU_ICON}<span class="stat-cpu${c}">${cpuText}</span></div>` +
         `<div class="stat-row">${STAT_MEM_ICON}<span class="stat-mem${c}">${memText}</span></div>`;
}

async function fetchStats(id) {
  const cell = document.querySelector(`[data-stats-id="${id}"]`);
  if (!cell) return;
  const res = await window.api.container.stats(id);
  if (!res.ok) { cell.innerHTML = statsMarkup('—', '—', 'muted'); return; }
  const normalize = localStorage.getItem('cpu-display') !== 'raw';
  const cpu = normalize ? res.cpu / (res.cpuCount || 1) : res.cpu;
  const cpuText = res.warming ? '…' : `${cpu.toFixed(1)}%`;
  cell.innerHTML = statsMarkup(cpuText, `${humanSize(res.memUsage)} / ${humanSize(res.memLimit)}`, res.warming ? 'muted' : '');
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
    const pending = pendingActions.get(c.id);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="dot ${running ? 'dot-running' : 'dot-stopped'}"></span>${c.state}</td>
      <td class="col-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td>
      <td class="mono col-image" title="${escapeHtml(c.image)}">${escapeHtml(c.image)}</td>
      <td class="stats-cell col-stats" data-stats-id="${c.id}">${running && !pending ? statsMarkup('…', '…', 'muted') : '—'}</td>
      <td class="ports col-ports" title="${c.ports.join('\n') || ''}">${c.ports.join('<br>') || '—'}</td>
      <td class="muted col-status">${pending ? `<span class="svc-pending">${pending}</span>` : escapeHtml(c.status)}</td>
      <td class="col-actions"><div class="actions"></div></td>`;
    const actions = tr.querySelector('.actions');

    if (pending) {
      actions.innerHTML = '<span class="row-spinner"></span>';
      body.appendChild(tr);
      continue;
    }

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
  applySort('containers-table');
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
  pendingActions.set(id, ACTION_VERB[action] || 'working…');
  markRowPending('containers-body', id);
  try {
    const res = await window.api.container[action](id);
    if (!res.ok) showError(res.error);
  } finally {
    pendingActions.delete(id);
    await refreshContainers();
  }
}

// Immediately swap a row into its spinner state without a full re-fetch, so the
// click feels instant even before the action resolves.
function markRowPending(bodyId, id) {
  const tr = document.querySelector(`#${bodyId} tr[data-svc-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`)
    || [...document.querySelectorAll(`#${bodyId} tr`)].find((r) => r.querySelector(`[data-stats-id="${id}"]`));
  if (!tr) return;
  const verb = pendingActions.get(id);
  const actions = tr.querySelector('.actions');
  if (actions) actions.innerHTML = '<span class="row-spinner"></span>';
  const status = tr.querySelector('.col-status, .compose-svc-status');
  if (status && verb) status.innerHTML = `<span class="svc-pending">${verb}</span>`;
}

async function removeContainer(id, name) {
  if (!confirm(`Remove container "${name}"? This cannot be undone.`)) return;
  const res = await window.api.container.remove(id, true);
  // On failure nothing changed; show a modal the user must dismiss and skip the
  // refresh (which would otherwise clear any toast).
  if (!res.ok) { showAlert(res.error, 'Could not remove container'); return; }
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
  applySort('images-table');
  applyFilter();
}

async function removeImage(id, tag) {
  if (!confirm(`Remove image "${tag}"?`)) return;
  const res = await window.api.image.remove(id, true);
  if (!res.ok) { showAlert(res.error, 'Could not remove image'); return; }
  await refreshImages();
}

function flashSuccess(msg) {
  const el = $('#global-error');
  $('#global-error-text').textContent = msg;
  el.classList.remove('hidden');
  el.style.borderColor = 'var(--green)';
  el.style.background = 'rgba(46,160,67,0.12)';
  el.style.color = '#7ee787';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 4000);
}

// Show exactly which dangling images a prune would remove, then confirm.
// Generic prune preview: shows exactly what would be removed, then runs onConfirm.
// rows: array of arrays of {text, cls}. Empty rows → show emptyText, hide Remove.
let pruneConfirmHandler = null;
function showPrunePreview({ title, summary, emptyText, rows, totalLabel, confirmLabel, onConfirm }) {
  $('#prune-title').textContent = title;
  const list = $('#prune-list');
  const confirmBtn = $('#prune-confirm');
  if (!rows.length) {
    $('#prune-summary').textContent = emptyText;
    list.innerHTML = '';
    $('#prune-total').textContent = '';
    confirmBtn.classList.add('hidden');
  } else {
    $('#prune-summary').textContent = summary;
    list.innerHTML = rows.map((cols) =>
      `<div class="prune-row">${cols.map((c) => `<span class="${c.cls || ''}">${c.text}</span>`).join('')}</div>`
    ).join('');
    $('#prune-total').textContent = totalLabel || '';
    confirmBtn.classList.remove('hidden');
    confirmBtn.textContent = confirmLabel;
  }
  pruneConfirmHandler = onConfirm;
  $('#prune-overlay').classList.remove('hidden');
}

function closePruneModal() { $('#prune-overlay').classList.add('hidden'); pruneConfirmHandler = null; }

async function confirmPrune() {
  const handler = pruneConfirmHandler;
  closePruneModal();
  if (handler) await handler();
}

async function pruneImages() {
  const res = await window.api.image.listDangling();
  if (!res.ok) { showError(res.error); return; }
  const imgs = res.images;
  const totalBytes = imgs.reduce((sum, i) => sum + (i.size || 0), 0);
  showPrunePreview({
    title: 'Prune dangling images',
    emptyText: 'No dangling images to remove.',
    summary: `${imgs.length} dangling image${imgs.length === 1 ? '' : 's'} will be removed (untagged <none> layers). Tagged images are kept.`,
    rows: imgs.map((i) => [
      { text: i.id, cls: 'mono' },
      { text: '&lt;none&gt;', cls: 'muted mono' },
      { text: humanSize(i.size), cls: 'muted' },
    ]),
    totalLabel: `Reclaims ~${humanSize(totalBytes)}`,
    confirmLabel: `Remove ${imgs.length} image${imgs.length === 1 ? '' : 's'}`,
    onConfirm: async () => {
      const r = await window.api.image.prune();
      if (!r.ok) { showError(r.error); return; }
      flashSuccess(`Pruned ${r.deleted || 0} image${r.deleted === 1 ? '' : 's'} — reclaimed ${humanSize(r.reclaimed)}`);
      await refreshImages();
    },
  });
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
  applySort('volumes-table');
  applyFilter();
}

async function inspectVolume(name) {
  const res = await window.api.volume.inspect(name);
  if (!res.ok) { showError(res.error); return; }
  const overlay = document.getElementById('command-overlay');
  document.querySelector('#command-overlay .modal-title').textContent = `Volume — ${name}`;
  document.getElementById('command-output').textContent = JSON.stringify(res.info, null, 2);
  overlay.classList.remove('hidden');
}

async function removeVolume(name) {
  if (!confirm(`Remove volume "${name}"? Data will be lost.`)) return;
  const res = await window.api.volume.remove(name);
  if (!res.ok) { showAlert(res.error, 'Could not remove volume'); return; }
  await refreshVolumes();
}

async function pruneVolumes() {
  const res = await window.api.volume.listPrunable();
  if (!res.ok) { showError(res.error); return; }
  const vols = res.volumes;
  showPrunePreview({
    title: 'Prune unused volumes',
    emptyText: 'No unused volumes to remove.',
    summary: `${vols.length} unused volume${vols.length === 1 ? '' : 's'} will be removed (not used by any container). Data in them will be lost.`,
    rows: vols.map((v) => [
      { text: escapeHtml(v.name), cls: 'mono' },
      { text: escapeHtml(v.driver), cls: 'muted' },
    ]),
    confirmLabel: `Remove ${vols.length} volume${vols.length === 1 ? '' : 's'}`,
    onConfirm: async () => {
      const r = await window.api.volume.prune();
      if (!r.ok) { showError(r.error); return; }
      flashSuccess(`Pruned ${r.count} volume(s) — reclaimed ${humanSize(r.reclaimed)}`);
      await refreshVolumes();
    },
  });
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
    headerActions.appendChild(mkBtn('Logs', 'btn btn-ghost btn-sm', () => openComposeLogs(project, services)));
    // Disable actions that have nothing to act on: Start when all running,
    // Stop/Restart when none running. Partial projects keep everything.
    const startBtn = mkBtn('Start', 'btn btn-green btn-sm', () => composeBulk(services, 'start'));
    startBtn.disabled = allRunning;
    const stopBtn = mkBtn('Stop', 'btn btn-red btn-sm', () => composeBulk(services, 'stop'));
    stopBtn.disabled = runningCount === 0;
    const restartBtn = mkBtn('Restart', 'btn btn-ghost btn-sm', () => composeBulk(services, 'restart'));
    restartBtn.disabled = runningCount === 0;
    headerActions.appendChild(startBtn);
    headerActions.appendChild(stopBtn);
    headerActions.appendChild(restartBtn);

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
        const pending = pendingActions.get(c.id);
        const tr = document.createElement('tr');
        tr.dataset.svcId = c.id;
        tr.innerHTML = `
          <td class="compose-svc-state">${pending ? '<span class="row-spinner"></span>' : `<span class="dot ${running ? 'dot-running' : 'dot-stopped'}"></span>`}</td>
          <td class="compose-svc-name">${escapeHtml(c.composeService || c.name)}</td>
          <td class="mono muted compose-svc-image" title="${escapeHtml(c.image)}">${escapeHtml(c.image)}</td>
          <td class="ports compose-svc-ports">${c.ports.join(', ') || '—'}</td>
          <td class="muted compose-svc-status">${pending ? `<span class="svc-pending">${pending}</span>` : escapeHtml(c.status)}</td>
          <td class="col-actions"><div class="actions"></div></td>`;
        const actions = tr.querySelector('.actions');
        if (pending) { tbody.appendChild(tr); continue; }
        if (running) {
          actions.appendChild(mkBtn('Stop', 'btn btn-red btn-sm', () => composeSvcAction('stop', c.id)));
          actions.appendChild(mkBtn('Restart', 'btn btn-ghost btn-sm', () => composeSvcAction('restart', c.id)));
        } else {
          actions.appendChild(mkBtn('Start', 'btn btn-green btn-sm', () => composeSvcAction('start', c.id)));
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

async function composeSvcAction(action, id) {
  pendingActions.set(id, ACTION_VERB[action] || 'working…');
  markRowPending('compose-body', id);
  try {
    const res = await window.api.container[action](id);
    if (!res.ok) showError(res.error);
  } finally {
    pendingActions.delete(id);
    await refreshCompose();
  }
}

async function composeBulk(services, action) {
  const targets = services.filter((s) => {
    if (action === 'start') return s.state !== 'running';
    if (action === 'stop') return s.state === 'running';
    return true; // restart all
  });
  const verb = ACTION_VERB[action] || 'working…';
  // Mark every affected row pending up front (survives event refreshes), then
  // fire concurrently and clear each as it resolves.
  targets.forEach((c) => { pendingActions.set(c.id, verb); markRowPending('compose-body', c.id); });
  await Promise.all(targets.map(async (c) => {
    try {
      const res = await window.api.container[action](c.id);
      if (!res.ok) showError(res.error);
    } finally {
      pendingActions.delete(c.id);
    }
  }));
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
  applySort('networks-table');
  applyFilter();
}

async function inspectNetwork(id) {
  const res = await window.api.network.inspect(id);
  if (!res.ok) { showError(res.error); return; }
  const overlay = document.getElementById('command-overlay');
  document.querySelector('#command-overlay .modal-title').textContent = `Network — ${res.info.Name}`;
  document.getElementById('command-output').textContent = JSON.stringify(res.info, null, 2);
  overlay.classList.remove('hidden');
}

async function removeNetwork(id, name) {
  if (!confirm(`Remove network "${name}"?`)) return;
  const res = await window.api.network.remove(id);
  if (!res.ok) { showAlert(res.error, 'Could not remove network'); return; }
  await refreshNetworks();
}

async function pruneNetworks() {
  const res = await window.api.network.listPrunable();
  if (!res.ok) { showError(res.error); return; }
  const nets = res.networks;
  showPrunePreview({
    title: 'Prune unused networks',
    emptyText: 'No unused networks to remove.',
    summary: `${nets.length} unused network${nets.length === 1 ? '' : 's'} will be removed (no connected containers). Built-in networks are kept.`,
    rows: nets.map((n) => [
      { text: escapeHtml(n.name), cls: 'mono' },
      { text: escapeHtml(n.driver), cls: 'muted' },
    ]),
    confirmLabel: `Remove ${nets.length} network${nets.length === 1 ? '' : 's'}`,
    onConfirm: async () => {
      const r = await window.api.network.prune();
      if (!r.ok) { showError(r.error); return; }
      flashSuccess(`Pruned ${r.count} network(s)`);
      await refreshNetworks();
    },
  });
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

  // Structured JSON logs (e.g. Colima/Lima): tint the whole line by its level.
  const jsonLevel = line.match(/"level":\s*"(\w+)"/);
  if (jsonLevel) {
    const lvl = jsonLevel[1].toLowerCase();
    if (lvl === 'error' || lvl === 'fatal' || lvl === 'panic') return `${ANSI.boldRed}${line}${ANSI.reset}`;
    if (lvl === 'warn' || lvl === 'warning') return `${ANSI.yellow}${line}${ANSI.reset}`;
    if (lvl === 'debug' || lvl === 'trace') return `${ANSI.dim}${line}${ANSI.reset}`;
    return line; // info/notice → default
  }

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

// Live/stopped indicator for the logs drawer, so a stopped container's stale
// logs aren't mistaken for a running one.
let logsEnded = false;

function setLogsStatus(kind, text) {
  const el = $('#logs-status');
  const term = $('#logs-output');
  el.classList.remove('hidden', 'live', 'stopped');
  if (kind === 'hidden') { el.classList.add('hidden'); el.textContent = ''; term.classList.remove('ended'); return; }
  if (kind === 'live') {
    el.classList.add('live');
    el.textContent = `● ${text || 'live'}`;
    term.classList.remove('ended');
  } else {
    el.classList.add('stopped');
    el.textContent = `■ ${text || 'stopped'}`;
    term.classList.add('ended');
  }
}

function markLogsStopped(banner) {
  if (logsEnded) return;
  logsEnded = true;
  setLogsStatus('stopped');
  if (logsTerm) {
    logsTerm.write(`\r\n\x1b[1;31m─── ${banner} ───\x1b[0m\r\n`);
    if ($('#logs-follow').checked) logsTerm.scrollToBottom();
  }
}

async function openLogs(id, name) {
  closeLogsStream();
  state.currentLogId = id;
  $('#logs-title').textContent = `Logs · ${name}`;
  $('#logs-drawer').classList.remove('hidden');
  syncDrawerLayout();

  ensureLogsTerm();
  logsTerm.options.theme = termTheme();
  logsTerm.reset();
  logsPartial = '';
  logsEnded = false;
  setLogsStatus('live');
  await new Promise((r) => requestAnimationFrame(r));
  try { logsFit.fit(); } catch (_) { /* noop */ }

  state.logUnsub = window.api.logs.onData((p) => {
    if (p.id !== state.currentLogId) return;
    appendLog(p.line, p.stream);
  });
  state.endUnsub = window.api.logs.onEnd((p) => {
    if (p.id && p.id !== state.currentLogId) return; // ignore other containers
    if (p.running) {
      // The log stream dropped but the container is still up — don't claim it
      // stopped. A genuine stop is detected from the Docker events stream below.
      setLogsStatus('live', 'live tail interrupted');
      return;
    }
    markLogsStopped(p.error ? `stream error: ${p.error}` : 'container stopped — showing final logs');
  });

  const res = await window.api.logs.start(id);
  if (!res.ok) { appendLog(`[failed to attach logs: ${res.error}]\n`, 'stderr'); markLogsStopped('could not attach to logs'); }
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
  syncDrawerLayout();
}

// Reserve space at the bottom of the scrollable main area equal to the drawer
// height, so the table can scroll clear of the (fixed-position) logs drawer
// instead of being hidden behind it.
function syncDrawerLayout() {
  const drawer = $('#logs-drawer');
  const main = $('#main');
  if (!main) return;
  main.style.paddingBottom = drawer.classList.contains('hidden') ? '' : `${drawer.offsetHeight}px`;
}

// Keep the drawer height within [MIN, 85% of viewport] so its top — and the
// resize handle at that top — can never end up off-screen above the window.
const DRAWER_MIN_H = 120;
const DRAWER_MAX_RATIO = 0.85;
function clampDrawerHeight() {
  const drawer = $('#logs-drawer');
  if (!drawer || drawer.classList.contains('hidden')) return;
  const max = window.innerHeight * DRAWER_MAX_RATIO;
  if (drawer.offsetHeight > max || drawer.offsetHeight < DRAWER_MIN_H) {
    drawer.style.height = Math.max(DRAWER_MIN_H, Math.min(max, drawer.offsetHeight)) + 'px';
  }
}

function closeLogsStream() {
  if (state.logUnsub) { state.logUnsub(); state.logUnsub = null; }
  if (state.endUnsub) { state.endUnsub(); state.endUnsub = null; }
  if (state.colimaLogUnsub) { state.colimaLogUnsub(); state.colimaLogUnsub = null; }
  if (state.composeLogUnsub) { state.composeLogUnsub(); state.composeLogUnsub = null; window.api.logs.stopCompose(); }
  if (state.composeEndUnsub) { state.composeEndUnsub(); state.composeEndUnsub = null; }
  window.api.logs.stop();
  state.currentLogId = null;
}

// Combined Compose logs — interleave every service, each line prefixed with a
// per-service colored tag (like `docker compose logs`). Buffer per service so a
// chunk split mid-line doesn't garble the prefix.
const COMPOSE_COLORS = ['\x1b[36m', '\x1b[32m', '\x1b[33m', '\x1b[35m', '\x1b[34m', '\x1b[96m', '\x1b[92m', '\x1b[95m'];
let composePartials = {};
let composePadWidth = 12;

function composeColorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return COMPOSE_COLORS[h % COMPOSE_COLORS.length];
}

function appendComposeLog(service, text, stream) {
  if (!logsTerm) return;
  const prev = composePartials[service] || '';
  const parts = (prev + text).split('\n');
  composePartials[service] = parts.pop();
  const color = composeColorFor(service);
  const label = (service.length > composePadWidth ? service.slice(0, composePadWidth) : service.padEnd(composePadWidth));
  const prefix = `${color}${label}\x1b[0m \x1b[90m|\x1b[0m `;
  for (const line of parts) {
    logsTerm.write(prefix + colorizeLine(line, stream) + '\r\n');
  }
  if ($('#logs-follow').checked) logsTerm.scrollToBottom();
}

let composeLiveServices = new Set();

function onComposeServiceEnd(service) {
  if (!composeLiveServices.has(service)) return; // already-stopped service: ignore
  composeLiveServices.delete(service);
  if (logsTerm) {
    const color = composeColorFor(service);
    const label = (service.length > composePadWidth ? service.slice(0, composePadWidth) : service.padEnd(composePadWidth));
    logsTerm.write(`${color}${label}\x1b[0m \x1b[90m|\x1b[0m \x1b[31m─ exited ─\x1b[0m\r\n`);
    if ($('#logs-follow').checked) logsTerm.scrollToBottom();
  }
  if (composeLiveServices.size === 0) markLogsStopped('all services stopped');
  else setLogsStatus('live', `${composeLiveServices.size} running`);
}

async function openComposeLogs(project, services) {
  composePartials = {};
  composePadWidth = Math.min(20, Math.max(...services.map((s) => (s.composeService || s.name).length), 6));
  await prepLogDrawer(`Compose · ${project}`);
  logsEnded = false;
  composeLiveServices = new Set(services.filter((s) => s.state === 'running').map((s) => s.composeService || s.name));
  if (composeLiveServices.size) setLogsStatus('live', `${composeLiveServices.size} running`);
  else markLogsStopped('no running services');
  const list = services.map((s) => ({ id: s.id, service: s.composeService || s.name }));
  state.composeLogUnsub = window.api.logs.onComposeData((p) => appendComposeLog(p.service, p.line, p.stream));
  state.composeEndUnsub = window.api.logs.onComposeEnd((p) => onComposeServiceEnd(p.service));
  const res = await window.api.logs.startCompose(list);
  if (!res.ok) appendLog(`[failed to attach compose logs: ${res.error}]\n`, 'stderr');
}

// Prepare the shared xterm drawer for a non-container source (Colima logs).
async function prepLogDrawer(title) {
  closeLogsStream();
  $('#logs-title').textContent = title;
  $('#logs-drawer').classList.remove('hidden');
  syncDrawerLayout();
  ensureLogsTerm();
  logsTerm.options.theme = termTheme();
  logsTerm.reset();
  logsPartial = '';
  logsEnded = false;
  setLogsStatus('hidden'); // compose overrides this; Colima logs leave it hidden
  await new Promise((r) => requestAnimationFrame(r));
  try { logsFit.fit(); } catch (_) { /* noop */ }
}

// Read the persisted Lima boot log and show it in the drawer.
async function viewColimaLogs() {
  await prepLogDrawer('Colima · startup log');
  const res = await window.api.colima.logs($('#colima-profile').value);
  if (!res.ok) { appendLog(`[${res.error}]\n`, 'stderr'); return; }
  appendLog(res.text, 'stdout');
}

// Subscribe to live `colima start` output and stream it into the drawer.
async function streamColimaStart() {
  await prepLogDrawer('Colima · starting…');
  state.colimaLogUnsub = window.api.colima.onStartLog((text) => appendLog(text, 'stdout'));
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
  clampDrawerHeight();
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
// Config modal does NOT close on outside click — only the X or Save buttons,
// so an accidental click can't discard in-progress edits.

// --------------------------------------------------------------------------
// Resizable logs drawer
// --------------------------------------------------------------------------
(function initDrawerResize() {
  const handle = document.getElementById('drawer-resize');
  const drawer = document.getElementById('logs-drawer');
  if (!handle || !drawer) return;

  const MIN_H = DRAWER_MIN_H;
  const MAX_RATIO = DRAWER_MAX_RATIO;

  // Clamp the restored height — a stale value saved while the window was larger
  // (or a max-drag) would otherwise push the drawer top, and its resize handle,
  // off-screen above the viewport, making resize impossible.
  const clampH = (h) => Math.max(MIN_H, Math.min(window.innerHeight * MAX_RATIO, h));
  const savedH = parseInt(localStorage.getItem('drawer-height'), 10);
  if (Number.isFinite(savedH)) drawer.style.height = clampH(savedH) + 'px';

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
    // Lock the whole row's action group while this action runs, so you can't
    // fire a conflicting op (e.g. Restart mid-Stop) on the same resource.
    const group = b.closest('.actions, .compose-actions');
    const siblings = group ? Array.from(group.querySelectorAll('button')) : [];
    b.classList.add('loading');
    siblings.forEach((s) => { if (s !== b) s.disabled = true; });
    try { await onClick(); }
    finally {
      b.classList.remove('loading');
      siblings.forEach((s) => { s.disabled = false; });
    }
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

  wrap.appendChild(trigger);
  wrap.appendChild(menu);
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
// When Colima isn't running there's no docker socket — wipe any stale rows so
// containers/images/etc. don't keep showing their last-known (e.g. "running")
// state, and stop the per-container stats timers.
function clearDataViews() {
  stopAllStatsTimers();
  for (const id of ['containers-body', 'images-body', 'volumes-body', 'networks-body']) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  }
  const compose = document.getElementById('compose-body');
  if (compose) compose.innerHTML = '';
  for (const [bodyId, emptyId] of [
    ['containers-body', 'containers-empty'],
    ['images-body', 'images-empty'],
    ['volumes-body', 'volumes-empty'],
    ['networks-body', 'networks-empty'],
    ['compose-body', 'compose-empty'],
  ]) {
    const empty = document.getElementById(emptyId);
    if (empty) empty.classList.toggle('hidden', `${state.tab}-body` !== bodyId);
  }
}

async function refreshActive() {
  if (refreshDebounce) return;
  refreshDebounce = setTimeout(() => { refreshDebounce = null; }, 500);
  const running = await refreshColima();
  if (!running) { clearDataViews(); return; }
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

// --------------------------------------------------------------------------
// Sortable tables — click a header to sort; click again to reverse. Sort state
// persists and is re-applied after each refresh (rows are rebuilt on refresh).
// Column type per table; null = not sortable (stats/ports/actions).
// --------------------------------------------------------------------------
const SORT_COLS = {
  'containers-table': ['text', 'text', 'text', null, null, 'text', null],
  'images-table': ['text', 'text', 'size', null],
  'volumes-table': ['text', 'text', 'date', null],
  'networks-table': ['text', 'text', 'text', 'text', 'num', null],
};
const sortState = {};

function sizeToBytes(s) {
  const m = String(s).match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!m) return 0;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return (parseFloat(m[1]) || 0) * (mult[(m[2] || 'B').toUpperCase()] || 1);
}

function cellSortVal(tr, idx, type) {
  const cell = tr.children[idx];
  const t = cell ? cell.textContent.trim() : '';
  if (type === 'size') return sizeToBytes(t);
  if (type === 'num') return parseFloat(t) || 0;
  if (type === 'date') return Date.parse(t) || 0;
  return t.toLowerCase();
}

function applySort(tableId) {
  const s = sortState[tableId];
  if (!s) return;
  const type = SORT_COLS[tableId][s.idx];
  if (!type) return;
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!tbody) return;
  const rows = Array.from(tbody.children);
  rows.sort((a, b) => {
    const av = cellSortVal(a, s.idx, type), bv = cellSortVal(b, s.idx, type);
    const cmp = (typeof av === 'number') ? av - bv : String(av).localeCompare(String(bv));
    return s.dir === 'desc' ? -cmp : cmp;
  });
  for (const r of rows) tbody.appendChild(r);
}

function updateSortIndicators(tableId) {
  const ths = document.querySelectorAll(`#${tableId} thead th`);
  const s = sortState[tableId];
  ths.forEach((th, idx) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (s && s.idx === idx) th.classList.add(s.dir === 'asc' ? 'sort-asc' : 'sort-desc');
  });
}

function initSortable() {
  for (const tableId of Object.keys(SORT_COLS)) {
    const ths = document.querySelectorAll(`#${tableId} thead th`);
    ths.forEach((th, idx) => {
      if (!SORT_COLS[tableId][idx]) return;
      th.classList.add('sortable');
      th.addEventListener('click', (e) => {
        if (e.target.closest('.col-resizer')) return; // don't sort while resizing
        const cur = sortState[tableId];
        const dir = (cur && cur.idx === idx && cur.dir === 'asc') ? 'desc' : 'asc';
        sortState[tableId] = { idx, dir };
        updateSortIndicators(tableId);
        applySort(tableId);
        applyFilter();
      });
    });
  }
}

// Events
$$('.nav-item[data-tab]').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
$('#btn-refresh').addEventListener('click', refreshActive);
$('#global-error-close').addEventListener('click', hideToast);
$('#alert-ok').addEventListener('click', closeAlert);
$('#alert-close').addEventListener('click', closeAlert);
$('#alert-overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeAlert(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#alert-overlay').classList.contains('hidden')) closeAlert();
});
$('#btn-prune').addEventListener('click', pruneImages);
$('#prune-cancel').addEventListener('click', closePruneModal);
$('#prune-close').addEventListener('click', closePruneModal);
$('#prune-confirm').addEventListener('click', confirmPrune);
$('#prune-overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closePruneModal(); });
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
  syncDrawerLayout();
});
$('#logs-clear').addEventListener('click', clearLogs);
$('#btn-colima-logs').addEventListener('click', viewColimaLogs);

$('#btn-colima-start').addEventListener('click', async () => {
  const btn = $('#btn-colima-start');
  btn.classList.add('loading');
  $('#colima-status').textContent = 'starting…';
  await streamColimaStart();
  try {
    const res = await window.api.colima.start($('#colima-profile').value);
    if (state.colimaLogUnsub) { state.colimaLogUnsub(); state.colimaLogUnsub = null; }
    if (!res.ok) showError(res.error);
    $('#logs-title').textContent = res.ok ? 'Colima · startup log' : 'Colima · start failed';
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
initSortable();
refreshActive();
setInterval(() => refreshColima(), 15000);
