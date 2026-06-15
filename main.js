'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
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

ipcMain.handle('colima:start', async (_e, profile) => {
  try {
    await colima(['start', '-p', profile || activeProfile]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('colima:stop', async (_e, profile) => {
  try {
    await colima(['stop', '-p', profile || activeProfile]);
    return { ok: true };
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
  try {
    const { docker } = getDocker();
    await docker.getImage(id).remove({ force: !!force });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('image:prune', async () => {
  try {
    const { docker } = getDocker();
    const result = await docker.pruneImages();
    const reclaimed = result.SpaceReclaimed || 0;
    return { ok: true, reclaimed };
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
ipcMain.handle('container:stats', async (_e, id) => {
  try {
    const { docker } = getDocker();
    const container = docker.getContainer(id);
    const stats = await container.stats({ stream: false });
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuCount = stats.cpu_stats.online_cpus || (stats.cpu_stats.cpu_usage.percpu_usage || []).length || 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;
    const memUsage = stats.memory_stats.usage - (stats.memory_stats.stats ? (stats.memory_stats.stats.cache || 0) : 0);
    const memLimit = stats.memory_stats.limit;
    return { ok: true, cpu: cpuPercent, cpuCount, memUsage, memLimit };
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

    logStream.on('end', () => send('logs:end', { id }));
    logStream.on('error', (e) => send('logs:end', { id, error: e.message }));

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
    title: 'Colima GUI',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  stopActiveLogStream();
  stopActiveExecStream();
  stopEventStream();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
