# Colima Desktop

Docker-Desktop-style GUI for [Colima](https://github.com/abiosoft/colima) on macOS.

Colima exposes the Docker Engine API over a unix socket at
`~/.colima/<profile>/docker.sock`. Colima Desktop shells out to `colima` for VM
lifecycle and uses `dockerode` against that socket for Docker resources.

## Features

- Start/stop Colima profiles and view persisted startup logs
- View containers, images, volumes, Compose projects, and networks
- Start/stop/restart/remove containers and Compose services
- Live container and combined Compose logs with xterm.js rendering
- Interactive container shell with xterm.js
- CPU/memory stats, sortable/filterable tables, and resizable columns
- Prune previews for dangling images, unused volumes, and unused networks
- Inspect volumes/networks and copy an approximate `docker run` command
- Edit Colima config with simple/advanced views

## Development

```bash
npm install
npm start
```

`npm start` builds the Preact renderer into `renderer-dist/` and launches
Electron against that build.

For Vite renderer development:

```bash
npm run dev:renderer
COLIMA_RENDERER_URL=http://127.0.0.1:5173 npm run start:dev
```

When verifying manually, be careful not to open the installed app from
`/Applications`. The development Electron build has bundle id
`com.github.Electron`; the installed app bundle id is `com.colima-gui.app`.

## Scripts

- `npm run build:renderer` — build the Preact/Vite renderer
- `npm test` — run Vitest tests for renderer logic
- `npm run dist:mac:universal` — build the universal macOS DMG

## Architecture

- `main.js` — Electron main process, Colima CLI calls, Docker API, IPC handlers
- `preload.js` — context-isolated `window.api` bridge
- `renderer/src` — Preact + TypeScript renderer
- `renderer-dist` — generated renderer build consumed by Electron/package builds

The renderer keeps xterm.js as imperative islands inside Preact components. Docker
events drive table refresh and authoritative log stop detection; log stream
failures alone do not mark running containers or Compose services as stopped.
