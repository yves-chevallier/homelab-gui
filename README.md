# Proxmox GUI — monitoring kiosk for a 1424×280 1U screen

Web monitoring interface for a Proxmox homelab, designed for an ultra-wide 1U
touchscreen (1424×280, ~5:1 ratio), running full screen in kiosk mode.

- **Grid view**: a single horizontal row of cards (scroll/swipe + snap).
  Order: PVE host → LXC/VM (sorted by vmid) → NAS → router. Card background
  color reflects status (green=running, red=stopped, orange=paused,
  gray=unknown).
- **Detail view** (tap a card): full screen, vertical scroll. Detailed metrics,
  charts (rrddata drawn on a canvas), optional embedded Grafana panel, Loki
  logs. Close with the `‹ back` button, the `Esc` key, or a swipe down.
- **Backend proxy**: the Proxmox API token stays server-side. The frontend only
  talks to the backend (single origin, no CORS). Polls every 3 s.
- **Responsive**: optimized for the 1U (single-row swipe layout on short
  viewports); on larger screens it reflows into a wrapping grid that scrolls
  vertically, so it also works on a desktop or tablet.

```
Browser (kiosk)
      │  same-origin fetch (poll 3s)
      ▼
Express backend  ──►  PVE API   https://192.168.20.2:8006  (token, cert ignored)
   (LXC 200)     ──►  Prometheus http://…:9090   (NAS / router cards)
                 ──►  Loki       http://…:3100    (detail-view logs)
                 ──►  Grafana    http://…:3000    (proxied iframe /grafana)
```

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

## Kiosk

Point the 1U screen's browser full screen at the URL, e.g. Chromium:

```sh
chromium --kiosk --incognito --noerrdialogs \
  --disable-pinch --overscroll-history-navigation=0 \
  --window-size=1424,280 http://192.168.20.50:8080
```

The app stores nothing (no `localStorage`); all state is in memory, so a plain
reload starts clean.
