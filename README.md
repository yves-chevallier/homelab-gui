<h1 align="center">Homelab GUI</h1>

<p align="center">
  <em>A fast, touch-friendly monitoring dashboard for a Proxmox homelab —<br>
  built for an ultra-wide 1U touchscreen (1424×280), responsive everywhere else.</em>
</p>

<p align="center">
  <a href="https://github.com/yves-chevallier/homelab-gui/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/yves-chevallier/homelab-gui/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node >= 20" src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg">
  <img alt="Dependencies: 3" src="https://img.shields.io/badge/deps-3-lightgrey.svg">
  <img alt="No build step" src="https://img.shields.io/badge/frontend-vanilla%20JS-yellow.svg">
</p>

---

At a glance: one aggregated poll every 3 s, cards colored by status, tap any card
for charts + logs, and a backend proxy that keeps your Proxmox token server-side.

## ✨ Features

- 🟩 **Status at a glance** — one horizontal row of cards, colored by state
  (green=running, red=stopped, orange=paused, gray=unknown). Order: PVE host →
  LXC/VM (by vmid) → NAS → router.
- 👆 **Touch-first** — swipe the grid horizontally, tap a card to zoom into a
  full-screen detail view, swipe down / `‹ back` / `Esc` to return.
- 📈 **Detail view** — live metrics, CPU/RAM/network charts (Proxmox `rrddata`
  drawn on a canvas), an optional embedded Grafana panel, and recent Loki logs.
- 🔒 **Secure by design** — the Proxmox API token never reaches the browser. The
  frontend talks only to the backend proxy (single origin, no CORS).
- 📱 **Responsive** — optimized for the 1U (single-row swipe layout on short
  screens); reflows into a wrapping vertical grid on desktops and tablets.
- 🪶 **Lightweight** — vanilla JS frontend (no build step, no CDN), 3 backend
  dependencies, stores nothing (no `localStorage`).

## 🧱 Architecture

```
Browser (kiosk)
      │  same-origin fetch (poll 3s)
      ▼
Express backend  ──►  PVE API   https://192.168.20.2:8006  (token, cert ignored)
   (LXC 200)     ──►  Prometheus http://…:9090   (NAS / router cards)
                 ──►  Loki       http://…:3100    (detail-view logs)
                 ──►  Grafana    http://…:3000    (proxied iframe /grafana)
```

## 🚀 Quick start

```sh
git clone https://github.com/yves-chevallier/homelab-gui.git
cd homelab-gui
npm install
cp .env.example .env         # then set PVE_TOKEN_ID / PVE_TOKEN_SECRET
npm start                    # → http://localhost:8080
```

Need a token? See [Read-only Proxmox token](#read-only-proxmox-token). Deploying
to your monitoring LXC? See [Inside LXC 200 (Docker)](#inside-lxc-200-docker-with-the-existing-stack).

## Layout

```
server/          Express backend (proxy for PVE / Prometheus / Loki / Grafana)
  config.js      reads env vars + config/cards.json
  upstream.js    PVE (self-signed cert ignored), Prometheus and Loki calls
  index.js       API routes + serves the static frontend
public/          frontend (vanilla HTML/CSS/JS, no CDN dependency)
config/cards.json  external cards (NAS, router) via Prometheus queries
Dockerfile / docker-compose.yml / .env.example
```

## Backend endpoints

| Route | Purpose |
|-------|---------|
| `GET /api/config` | Non-secret config for the frontend (pollMs, node, grafana) |
| `GET /api/grid` | **Single** aggregated response: host + guests + NAS + router |
| `GET /api/rrd/node?timeframe=hour` | PVE host time series |
| `GET /api/rrd/:type/:vmid?timeframe=hour` | Guest time series (`lxc`/`qemu`) |
| `GET /api/logs?host=<name>&limit=150` | Loki logs `{host="<name>"}` |
| `/grafana/*` | Reverse proxy to Grafana (iframe embed) |

`/api/grid` is fault tolerant: if a source fails, the affected card falls back to
`unknown` without breaking the rest.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Backend listen port |
| `POLL_MS` | `3000` | Frontend poll interval |
| `PVE_HOST` | `192.168.20.2` | Proxmox host |
| `PVE_PORT` | `8006` | Proxmox API port |
| `PVE_NODE` | `pve` | PVE node name |
| `PVE_TOKEN_ID` | — | API token id (`user@realm!name`) |
| `PVE_TOKEN_SECRET` | — | API token secret |
| `PROM_URL` | `http://192.168.20.50:9090` | Prometheus |
| `LOKI_URL` | `http://192.168.20.50:3100` | Loki |
| `GRAFANA_URL` | `http://192.168.20.50:3000` | Grafana (empty = tab disabled) |
| `LOKI_LABEL` | `host` | Loki label used to filter logs per machine |

Copy `.env.example` → `.env` and set at least the PVE token.

## Read-only Proxmox token

Create a dedicated user, a read-only role (`VM.Audit` + `Sys.Audit`, plus
`Datastore.Audit` to see storage), and a token. On the PVE host:

```sh
# 1) dedicated user in the PVE realm
pveum user add monitor@pve

# 2) read-only (audit) role
pveum role add Monitoring -privs "VM.Audit Sys.Audit Datastore.Audit"

# 3) grant it read access over the whole tree
pveum acl modify / -user monitor@pve -role Monitoring

# 4) token WITHOUT privilege separation so it inherits the user's privileges
pveum user token add monitor@pve gui --privsep 0
```

The last command prints the **secret only once**:

```
┌──────────────┬──────────────────────────────────────┐
│ key          │ value                                │
├──────────────┼──────────────────────────────────────┤
│ full-tokenid │ monitor@pve!gui                      │
│ value        │ xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  │
└──────────────┴──────────────────────────────────────┘
```

Put it in `.env`:

```
PVE_TOKEN_ID=monitor@pve!gui
PVE_TOKEN_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

> The backend sends `Authorization: PVEAPIToken=<id>=<secret>` and ignores the
> self-signed certificate on `:8006` (for PVE host calls only).

## NAS & router cards (Prometheus)

These cards don't come from the PVE API but from instant Prometheus queries
defined in [`config/cards.json`](config/cards.json). Each card provides up to 5
queries: `up` (1/0 → running/stopped), `cpu` (0..1), `mem` (bytes), `memMax`
(bytes), `uptime` (seconds).

The queries shipped here are already tuned to this setup: the **Synology NAS**
is scraped via `snmp_exporter` (UCD-SNMP `ssCpu*`, HOST-RESOURCES `hrStorage*`,
`sysUpTime`, label `host="hodor"`); the **OPNsense router** via Telegraf
(`cpu_usage_idle`, `mem_used`/`mem_total`, `system_uptime`, label
`host="opnsense"`). If your metric names differ, check the Prometheus explorer
and adjust — a missing/empty query just shows `—` and the card stays visible.

## Embedded Grafana (optional)

Each card's `grafana` field (in `cards.json`; add it for guests too if you want)
points to a `/grafana/...` URL proxied by the backend. For the iframe to render,
on the Grafana side:

- `grafana.ini` → `[security] allow_embedding = true`
- to skip login: `[auth.anonymous] enabled = true` (Viewer org), or use public
  dashboard links.
- URL like `/grafana/d/<uid>/<slug>?kiosk&theme=dark&panelId=<n>`.

Reference dashboards: **10347** (Proxmox), **14284** (Synology), **OPNsense
Cockpit**.

## Run

### Locally (dev)

```sh
npm install
cp .env.example .env      # set the PVE token
export $(grep -v '^#' .env | xargs)   # or use an env loader
npm start
# → http://localhost:8080
```

### Inside LXC 200 (Docker, with the existing stack)

Add the service to the monitoring stack's `docker-compose.yml` (see the provided
[`docker-compose.yml`](docker-compose.yml): it reaches Prometheus/Loki/Grafana by
service name, and the PVE host by IP). Set the token in the stack's `.env`, then:

```sh
docker compose up -d --build proxmox-gui
# → http://192.168.20.50:8080
```

## Development

```sh
npm run dev     # start with --watch (auto-restart on change)
npm run check   # syntax-check all JS + validate config/cards.json
npm test        # boot the server and assert it serves /api/config + the UI
```

CI (GitHub Actions) runs `check` + `test` on Node 20 and 22 and builds the
Docker image on every push and pull request — see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Kiosk

Point the 1U screen's browser full screen at the URL, e.g. Chromium:

```sh
chromium --kiosk --incognito --noerrdialogs \
  --disable-pinch --overscroll-history-navigation=0 \
  --window-size=1424,280 http://192.168.20.50:8080
```

The app stores nothing (no `localStorage`); all state is in memory, so a plain
reload starts clean.
