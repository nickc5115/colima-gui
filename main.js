'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { PassThrough } = require('stream');
const Docker = require('dockerode');
const yaml = require('js-yaml');

// ---------------------------------------------------------------------------
// macOS gotcha: apps launched from Finder/Dock do NOT inherit your shell PATH,
// so `colima` (installed via Homebrew) won't be found. Prepend the usual brew
// locations. `npm start` from a terminal works fine either way.
// ---------------------------------------------------------------------------
const BIN_PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH]
  .filter(Boolean)
  .join(':');
const EXEC_ENV = { ...process.env, PATH: BIN_PATH };

// Active profile (Colima default is "default"). Swappable from the UI later.
let activeProfile = 'default';

ipcMain.handle('system:openExternal', async (_e, url) => {
  try {
    const parsed = new URL(String(url));
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, error: 'Only http/https URLs can be opened externally.' };
    }
    await shell.openExternal(parsed.toString());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// One dockerode client per resolved socket path, cached.
const dockerClients = new Map();

function socketPathForProfile(profile) {
  // Honor DOCKER_HOST if it points at a unix socket, otherwise use Colima's
  // conventional per-profile socket location.
  const host = process.env.DOCKER_HOST || '';
  if (host.startsWith('unix://')) return host.replace('unix://', '');
  return path.join(colimaHome(), profile, 'docker.sock');
}

function getDocker(profile = activeProfile) {
  const socketPath = socketPathForProfile(profile);
  if (!dockerClients.has(socketPath)) {
    dockerClients.set(socketPath, new Docker({ socketPath }));
  }
  return { docker: dockerClients.get(socketPath), socketPath };
}

function colima(args) {
  return new Promise((resolve, reject) => {
    execFile('colima', args, { env: EXEC_ENV, timeout: 120000 }, (err, stdout, stderr) => {
      // `colima` writes a lot of progress to stderr even on success, so don't
      // treat non-empty stderr as failure — only a non-zero exit code.
      if (err && typeof err.code === 'number' && err.code !== 0) {
        return reject(new Error(stderr || err.message));
      }
      if (err && err.code === 'ENOENT') {
        return reject(new Error('`colima` not found on PATH. Is it installed? (brew install colima)'));
      }
      resolve({ stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// IPC: Colima lifecycle
// ---------------------------------------------------------------------------
ipcMain.handle('colima:list', async () => {
  try {
    const { stdout } = await colima(['list', '--json']);
    const profiles = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return { ok: true, profiles };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Start streams its progress live to the renderer ('colima:startlog') so the
// user can watch the VM boot/provision, then resolves ok/error on exit.
ipcMain.handle('colima:start', async (event, profile) => {
  return new Promise((resolve) => {
    const send = (channel, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
    };
    let child;
    try {
      child = spawn('colima', ['start', '-p', profile || activeProfile, '--verbose'], { env: EXEC_ENV });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    let stderr = '';
    child.stdout.on('data', (d) => send('colima:startlog', d.toString('utf8')));
    child.stderr.on('data', (d) => { const s = d.toString('utf8'); stderr += s; send('colima:startlog', s); });
    child.on('error', (e) => {
      if (e.code === 'ENOENT') return resolve({ ok: false, error: '`colima` not found on PATH. Is it installed? (brew install colima)' });
      resolve({ ok: false, error: e.message });
    });
    child.on('close', (code) => {
      send('colima:startlog', `\n[colima start exited with code ${code}]\n`);
      resolve(code === 0 ? { ok: true } : { ok: false, error: stderr || `colima start exited ${code}` });
    });
  });
});

ipcMain.handle('colima:stop', async (_e, profile) => {
  try {
    await colima(['stop', '-p', profile || activeProfile]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Read the persisted Lima host-agent log (the boot/provisioning output) for the
// instance backing this profile. Default profile → lima instance "colima".
function limaInstanceName(profile) {
  const p = profile || activeProfile;
  return p === 'default' ? 'colima' : `colima-${p}`;
}

ipcMain.handle('colima:logs', async (_e, profile) => {
  try {
    const dir = path.join(colimaHome(), '_lima', limaInstanceName(profile));
    const stderrPath = path.join(dir, 'ha.stderr.log');
    if (!fs.existsSync(stderrPath)) {
      return { ok: false, error: `No Colima log found at ${stderrPath}. Has the profile been started?` };
    }
    const text = fs.readFileSync(stderrPath, 'utf8');
    return { ok: true, text, path: stderrPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('colima:setProfile', async (_e, profile) => {
  activeProfile = profile || 'default';
  return { ok: true, profile: activeProfile };
});

// ---------------------------------------------------------------------------
// IPC: Docker — containers & images
// ---------------------------------------------------------------------------
ipcMain.handle('docker:containers', async () => {
  try {
    const { docker, socketPath } = getDocker();
    if (!fs.existsSync(socketPath)) {
      return { ok: false, error: `Docker socket not found at ${socketPath}. Is Colima running?` };
    }
    const list = await docker.listContainers({ all: true });
    const containers = list.map((c) => {
      const labels = c.Labels || {};
      return {
        id: c.Id,
        name: (c.Names && c.Names[0] ? c.Names[0] : c.Id).replace(/^\//, ''),
        image: c.Image,
        state: c.State, // running | exited | paused | created ...
        status: c.Status, // human-readable "Up 3 minutes"
        ports: (c.Ports || [])
          .filter((p) => p.PublicPort)
          .map((p) => `${p.PublicPort}:${p.PrivatePort}/${p.Type}`),
        composeProject: labels['com.docker.compose.project'] || null,
        composeService: labels['com.docker.compose.service'] || null,
        composeWorkdir: labels['com.docker.compose.project.working_dir'] || null,
      };
    });
    return { ok: true, containers };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('docker:images', async () => {
  try {
    const { docker, socketPath } = getDocker();
    if (!fs.existsSync(socketPath)) {
      return { ok: false, error: `Docker socket not found at ${socketPath}. Is Colima running?` };
    }
    const list = await docker.listImages();
    const images = list.map((img) => {
      const tags = img.RepoTags && img.RepoTags.length ? img.RepoTags : ['<none>:<none>'];
      return {
        id: img.Id.replace('sha256:', '').slice(0, 12),
        tags,
        size: img.Size,
        created: img.Created,
      };
    });
    return { ok: true, images };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---------------------------------------------------------------------------
// IPC: container actions
// ---------------------------------------------------------------------------
async function containerAction(id, action) {
  const { docker } = getDocker();
  const container = docker.getContainer(id);
  await container[action]();
}

ipcMain.handle('container:start', async (_e, id) => {
  try { await containerAction(id, 'start'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('container:stop', async (_e, id) => {
  try { await containerAction(id, 'stop'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('container:restart', async (_e, id) => {
  try { await containerAction(id, 'restart'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('container:remove', async (_e, id, force) => {
  try {
    const { docker } = getDocker();
    await docker.getContainer(id).remove({ force: !!force });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---------------------------------------------------------------------------
// IPC: image actions
// ---------------------------------------------------------------------------
ipcMain.handle('image:remove', async (_e, id, force) => {
  const { docker } = getDocker();
  try {
    await docker.getImage(id).remove({ force: !!force });
    return { ok: true };
  } catch (e) {
    // Image-in-use conflicts return HTTP 409 with a daemon message that names the
    // blocking container by ID. Resolve that to a name/state so the message is useful.
    const raw = (e.json && e.json.message) || e.message || String(e);
    if (e.statusCode === 409 || /image is being used|being used by|cannot be forced/i.test(raw)) {
      const m = raw.match(/being used by (?:running|stopped) container ([0-9a-f]+)/i);
      let detail = '';
      if (m) {
        try {
          const info = await docker.getContainer(m[1]).inspect();
          const name = (info.Name || '').replace(/^\//, '') || m[1].slice(0, 12);
          const state = info.State && info.State.Running ? 'running' : 'stopped';
          detail = ` It is in use by ${state} container "${name}". ` +
            (state === 'running' ? 'Stop and remove that container first.' : 'Remove that container first.');
        } catch {
          detail = ` It is in use by container ${m[1].slice(0, 12)}. Remove that container first.`;
        }
      }
      return { ok: false, error: `Cannot remove image — it is being used by a container.${detail}` };
    }
    return { ok: false, error: raw };
  }
});

// Preview: the dangling images a prune would remove (untagged <none> layers).
ipcMain.handle('image:listDangling', async () => {
  try {
    const { docker, socketPath } = getDocker();
    if (!fs.existsSync(socketPath)) {
      return { ok: false, error: `Docker socket not found at ${socketPath}. Is Colima running?` };
    }
    const list = await docker.listImages({ filters: JSON.stringify({ dangling: ['true'] }) });
    const images = list.map((img) => ({
      id: img.Id.replace('sha256:', '').slice(0, 12),
      size: img.Size,
      created: img.Created,
    }));
    return { ok: true, images };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('image:prune', async () => {
  try {
    const { docker } = getDocker();
    const result = await docker.pruneImages();
    const reclaimed = result.SpaceReclaimed || 0;
    const deleted = (result.ImagesDeleted || []).filter((d) => d.Deleted).length;
    return { ok: true, reclaimed, deleted };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---------------------------------------------------------------------------
// IPC: container inspect
// ---------------------------------------------------------------------------
ipcMain.handle('container:inspect', async (_e, id) => {
  try {
    const { docker } = getDocker();
    const info = await docker.getContainer(id).inspect();
    return { ok: true, info };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---------------------------------------------------------------------------
// IPC: container exec (interactive shell)
// ---------------------------------------------------------------------------
let activeExecStream = null;

function stopActiveExecStream() {
  if (activeExecStream) {
    try { activeExecStream.destroy(); } catch (_) { /* noop */ }
    activeExecStream = null;
  }
}

let activeExec = null;

ipcMain.handle('exec:start', async (event, id, shell, size) => {
  try {
    stopActiveExecStream();
    const { docker } = getDocker();
    const container = docker.getContainer(id);
    const exec = await container.exec({
      Cmd: [shell || '/bin/sh'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    activeExecStream = stream;
    activeExec = exec;

    // Match the PTY to the terminal's dimensions so line-wrapping is correct.
    if (size && size.cols && size.rows) {
      try { await exec.resize({ w: size.cols, h: size.rows }); } catch (_) { /* noop */ }
    }

    const send = (channel, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
    };

    stream.on('data', (chunk) => send('exec:data', chunk.toString('utf8')));
    stream.on('end', () => send('exec:end', {}));
    stream.on('error', (e) => send('exec:end', { error: e.message }));

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('exec:write', async (_e, data) => {
  if (activeExecStream) {
    activeExecStream.write(data);
    return { ok: true };
  }
  return { ok: false, error: 'No active exec session' };
});

ipcMain.handle('exec:resize', async (_e, cols, rows) => {
  if (activeExec && cols && rows) {
    try { await activeExec.resize({ w: cols, h: rows }); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: false };
});

ipcMain.handle('exec:stop', async () => {
  stopActiveExecStream();
  activeExec = null;
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC: container stats (one-shot)
// ---------------------------------------------------------------------------
function statNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

ipcMain.handle('container:stats', async (_e, id) => {
  try {
    const { docker } = getDocker();
    const container = docker.getContainer(id);
    const stats = await container.stats({ stream: false });
    const snapshot = stats || {};
    const cpuStats = snapshot.cpu_stats || {};
    const preCpuStats = snapshot.precpu_stats || {};
    const cpuUsage = cpuStats.cpu_usage || {};
    const preCpuUsage = preCpuStats.cpu_usage || {};
    const totalUsage = statNumber(cpuUsage.total_usage);
    const preTotalUsage = statNumber(preCpuUsage.total_usage);
    const systemUsage = statNumber(cpuStats.system_cpu_usage);
    const preSystemUsage = statNumber(preCpuStats.system_cpu_usage);
    const cpuCount = statNumber(cpuStats.online_cpus)
      || (Array.isArray(cpuUsage.percpu_usage) ? cpuUsage.percpu_usage.length : 0)
      || 1;

    let cpuPercent = 0;
    let warming = true;
    if (totalUsage !== null && preTotalUsage !== null && systemUsage !== null && preSystemUsage !== null && preTotalUsage > 0 && preSystemUsage > 0) {
      const cpuDelta = totalUsage - preTotalUsage;
      const systemDelta = systemUsage - preSystemUsage;
      cpuPercent = cpuDelta > 0 && systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;
      warming = false;
    }

    const memoryStats = snapshot.memory_stats || {};
    const memoryInnerStats = memoryStats.stats || {};
    const memUsageRaw = statNumber(memoryStats.usage) || 0;
    const memCache = statNumber(memoryInnerStats.cache) || 0;
    const memUsage = Math.max(0, memUsageRaw - memCache);
    const memLimit = statNumber(memoryStats.limit) || 0;
    return { ok: true, cpu: cpuPercent, cpuCount, memUsage, memLimit, warming };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---------------------------------------------------------------------------
// IPC: live log streaming
// One active stream at a time keeps the MVP simple. Streams demux'd chunks to
// the renderer over 'logs:data' events, keyed by container id.
// ---------------------------------------------------------------------------
let activeLogStream = null;

function stopActiveLogStream() {
  if (activeLogStream) {
    try { activeLogStream.destroy(); } catch (_) { /* noop */ }
    activeLogStream = null;
  }
}

ipcMain.handle('logs:start', async (event, id) => {
  try {
    stopActiveLogStream();
    const { docker } = getDocker();
    const container = docker.getContainer(id);

    // TTY containers emit a raw stream; non-TTY containers emit a multiplexed
    // stream that must be demux'd (8-byte frame headers). Inspect to find out.
    const info = await container.inspect();
    const hasTty = info && info.Config && info.Config.Tty;

    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 500,
      timestamps: false,
    });
    activeLogStream = logStream;

    const send = (channel, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
    };

    if (hasTty) {
      logStream.on('data', (chunk) => send('logs:data', { id, line: chunk.toString('utf8'), stream: 'stdout' }));
    } else {
      const out = new PassThrough();
      const err = new PassThrough();
      out.on('data', (chunk) => send('logs:data', { id, line: chunk.toString('utf8'), stream: 'stdout' }));
      err.on('data', (chunk) => send('logs:data', { id, line: chunk.toString('utf8'), stream: 'stderr' }));
      container.modem.demuxStream(logStream, out, err);
    }

    // The follow-stream can end/error for reasons unrelated to the container
    // stopping (e.g. a daemon log-driver hiccup). Report the container's ACTUAL
    // running state so the renderer doesn't mislabel a live container as stopped.
    const sendEnd = (extra) => {
      container.inspect()
        .then((i) => send('logs:end', { id, running: !!(i.State && i.State.Running), ...extra }))
        .catch(() => send('logs:end', { id, running: false, ...extra }));
    };
    logStream.on('end', () => sendEnd({}));
    logStream.on('error', (e) => sendEnd({ error: e.message }));

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('logs:stop', async () => {
  stopActiveLogStream();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC: combined Compose logs — stream every service in a project at once,
// tagging each chunk with its service name so the renderer can interleave them
// like `docker compose logs -f`.
// ---------------------------------------------------------------------------
let activeComposeStreams = [];

function stopComposeStreams() {
  for (const s of activeComposeStreams) {
    try { s.destroy(); } catch (_) { /* noop */ }
  }
  activeComposeStreams = [];
}

ipcMain.handle('logs:startCompose', async (event, services) => {
  try {
    stopComposeStreams();
    const { docker } = getDocker();
    const send = (channel, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
    };

    for (const svc of services || []) {
      try {
        const container = docker.getContainer(svc.id);
        const info = await container.inspect();
        const hasTty = info && info.Config && info.Config.Tty;
        const logStream = await container.logs({
          follow: true, stdout: true, stderr: true, tail: 200, timestamps: false,
        });
        activeComposeStreams.push(logStream);

        if (hasTty) {
          logStream.on('data', (c) => send('logs:composeData', { service: svc.service, line: c.toString('utf8'), stream: 'stdout' }));
        } else {
          const out = new PassThrough();
          const err = new PassThrough();
          out.on('data', (c) => send('logs:composeData', { service: svc.service, line: c.toString('utf8'), stream: 'stdout' }));
          err.on('data', (c) => send('logs:composeData', { service: svc.service, line: c.toString('utf8'), stream: 'stderr' }));
          container.modem.demuxStream(logStream, out, err);
        }
        // A service's stream ends when its container stops — tell the renderer
        // so it can show the service (and eventually the whole project) as stopped.
        logStream.on('end', () => send('logs:composeEnd', { service: svc.service }));
        logStream.on('error', () => send('logs:composeEnd', { service: svc.service }));
      } catch (e) {
        send('logs:composeData', { service: svc.service, line: `[failed to attach: ${e.message}]\n`, stream: 'stderr' });
        send('logs:composeEnd', { service: svc.service });
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('logs:stopCompose', async () => {
  stopComposeStreams();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC: Docker events stream — replaces polling
// ---------------------------------------------------------------------------
let activeEventStream = null;

function stopEventStream() {
  if (activeEventStream) {
    try { activeEventStream.destroy(); } catch (_) { /* noop */ }
    activeEventStream = null;
  }
}

ipcMain.handle('events:start', async (event) => {
  try {
    stopEventStream();
    const { docker, socketPath } = getDocker();
    if (!fs.existsSync(socketPath)) return { ok: false, error: 'Socket not found' };
    const stream = await docker.getEvents({
      filters: { type: ['container', 'image'] },
    });
    activeEventStream = stream;
    const send = (channel, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
    };
    stream.on('data', (chunk) => {
      try {
        const evt = JSON.parse(chunk.toString('utf8'));
        send('events:data', evt);
      } catch (_) { /* ignore parse errors from partial chunks */ }
    });
    stream.on('end', () => send('events:end', {}));
    stream.on('error', (e) => send('events:end', { error: e.message }));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('events:stop', async () => {
  stopEventStream();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC: Docker volumes
// ---------------------------------------------------------------------------
ipcMain.handle('docker:volumes', async () => {
  try {
    const { docker, socketPath } = getDocker();
    if (!fs.existsSync(socketPath)) {
      return { ok: false, error: `Docker socket not found at ${socketPath}. Is Colima running?` };
    }
    const result = await docker.listVolumes();
    const volumes = (result.Volumes || []).map((v) => ({
      name: v.Name,
      driver: v.Driver,
      mountpoint: v.Mountpoint,
      scope: v.Scope,
      created: v.CreatedAt,
      labels: v.Labels || {},
    }));
    return { ok: true, volumes };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('volume:inspect', async (_e, name) => {
  try {
    const { docker } = getDocker();
    const vol = docker.getVolume(name);
    const info = await vol.inspect();
    return { ok: true, info };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('volume:remove', async (_e, name) => {
  try {
    const { docker } = getDocker();
    await docker.getVolume(name).remove();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Preview: volumes a prune would remove (those not used by any container).
ipcMain.handle('volume:listPrunable', async () => {
  try {
    const { docker, socketPath } = getDocker();
    if (!fs.existsSync(socketPath)) return { ok: false, error: 'Colima not running' };
    const result = await docker.listVolumes({ filters: JSON.stringify({ dangling: ['true'] }) });
    const volumes = (result.Volumes || []).map((v) => ({ name: v.Name, driver: v.Driver }));
    return { ok: true, volumes };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('volume:prune', async () => {
  try {
    const { docker } = getDocker();
    const result = await docker.pruneVolumes();
    const reclaimed = result.SpaceReclaimed || 0;
    return { ok: true, reclaimed, count: (result.VolumesDeleted || []).length };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---------------------------------------------------------------------------
// IPC: Docker networks
// ---------------------------------------------------------------------------
ipcMain.handle('docker:networks', async () => {
  try {
    const { docker, socketPath } = getDocker();
    if (!fs.existsSync(socketPath)) {
      return { ok: false, error: `Docker socket not found at ${socketPath}. Is Colima running?` };
    }
    const list = await docker.listNetworks();
    const networks = list.map((n) => ({
      id: n.Id.slice(0, 12),
      name: n.Name,
      driver: n.Driver,
      scope: n.Scope,
      internal: n.Internal,
      ipam: (n.IPAM && n.IPAM.Config && n.IPAM.Config[0] && n.IPAM.Config[0].Subnet) || '',
      containerCount: n.Containers ? Object.keys(n.Containers).length : null,
      builtin: ['bridge', 'host', 'none'].includes(n.Name),
    }));
    return { ok: true, networks };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('network:inspect', async (_e, id) => {
  try {
    const { docker } = getDocker();
    const info = await docker.getNetwork(id).inspect();
    return { ok: true, info };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('network:remove', async (_e, id) => {
  try {
    const { docker } = getDocker();
    await docker.getNetwork(id).remove();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Preview: networks a prune would remove — non-builtin local networks with no
// connected containers. Inspect each to get an accurate container count.
ipcMain.handle('network:listPrunable', async () => {
  try {
    const { docker, socketPath } = getDocker();
    if (!fs.existsSync(socketPath)) return { ok: false, error: 'Colima not running' };
    const list = await docker.listNetworks();
    const out = [];
    for (const n of list) {
      if (['bridge', 'host', 'none'].includes(n.Name)) continue;
      if (n.Scope && n.Scope !== 'local') continue;
      let count = 0;
      try {
        const info = await docker.getNetwork(n.Id).inspect();
        count = info.Containers ? Object.keys(info.Containers).length : 0;
      } catch (_) { /* if inspect fails, assume in-use to be safe */ count = 1; }
      if (count === 0) out.push({ id: n.Id.slice(0, 12), name: n.Name, driver: n.Driver });
    }
    return { ok: true, networks: out };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('network:prune', async () => {
  try {
    const { docker } = getDocker();
    const result = await docker.pruneNetworks();
    return { ok: true, count: (result.NetworksDeleted || []).length };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---------------------------------------------------------------------------
// IPC: Colima config
// ---------------------------------------------------------------------------
function colimaHome() {
  return process.env.COLIMA_HOME || path.join(os.homedir(), '.colima');
}

function configPathForProfile(profile) {
  return path.join(colimaHome(), profile || activeProfile, 'colima.yaml');
}

ipcMain.handle('config:read', async (_e, profile) => {
  try {
    const cfgPath = configPathForProfile(profile);
    if (!fs.existsSync(cfgPath)) {
      return { ok: false, error: `Config not found at ${cfgPath}. Start the profile first.` };
    }
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = yaml.load(raw) || {};
    return { ok: true, raw, parsed, path: cfgPath };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:write', async (_e, profile, content) => {
  try {
    const cfgPath = configPathForProfile(profile);
    if (typeof content === 'object') {
      content = yaml.dump(content, { lineWidth: -1, noRefs: true });
    } else {
      yaml.load(content);
    }
    fs.writeFileSync(cfgPath, content, 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 820,
    minHeight: 520,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    title: 'Colima Desktop',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const rendererUrl = process.env.COLIMA_RENDERER_URL;
  if (rendererUrl) {
    win.loadURL(rendererUrl);
  } else {
    win.loadFile(path.join(__dirname, 'renderer-dist', 'index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  stopActiveLogStream();
  stopActiveExecStream();
  stopComposeStreams();
  stopEventStream();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
