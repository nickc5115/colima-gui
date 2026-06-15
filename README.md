# Colima GUI

A minimal Docker-Desktop-style GUI for [Colima](https://github.com/abiosoft/colima).
Electron + dockerode. Does the three things that actually matter day-to-day:

- View containers (all states) and images
- Start / stop / restart containers
- **Live-streaming container logs** (demux'd stdout/stderr, auto-scroll)
- Start / stop the Colima VM, with status + specs

## How it works

Colima boots a Lima VM and exposes the **Docker Engine API** over a unix socket
at `~/.colima/<profile>/docker.sock`. This app:

- shells out to `colima list/start/stop` for VM lifecycle, and
- talks to that socket via `dockerode` for everything container/image related.

That's the whole trick — the container UI is identical to what you'd build
against Docker Desktop, because it's the same API.

## Run

```bash
npm install
npm start
```

Requires Colima installed (`brew install colima docker`) and a profile that has
been started at least once (`colima start`).

## Notes / known rough edges (v1)

- **Profiles:** hardcoded to `default`. The plumbing (`-p <profile>`) is there in
  `main.js`; wiring a profile dropdown is a small renderer change.
- **Single log stream:** one container's logs at a time, to keep state simple.
- **Polling:** the list refreshes every 5s (paused while the logs drawer is open).
  Swapping to Docker's `/events` stream would make it instant.
- **PATH fix:** when launched from Finder (not a terminal), macOS apps don't inherit
  your shell PATH, so `/opt/homebrew/bin` is prepended in `main.js` so `colima`
  resolves. If yours lives elsewhere, adjust `BIN_PATH`.
- **Socket override:** honors `DOCKER_HOST` if it's a `unix://` socket.

## Obvious next features

- `docker /events` for live updates instead of polling
- exec into a container (xterm.js + hijacked stream)
- image pull / prune, container rm
- stats (CPU/mem) via `/containers/{id}/stats`
- package as a real `.app` with electron-builder
