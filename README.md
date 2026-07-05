# Proxmox GUI — kiosk monitoring pour écran 1U 1424×280

Interface web de monitoring du homelab Proxmox, pensée pour un écran tactile
1U ultra-large (1424×280, ratio ~5:1), en plein écran / mode kiosque.

- **Vue grille** : une seule rangée horizontale de cartes (scroll/swipe + snap).
  Ordre : host PVE → LXC/VM (triés par vmid) → NAS → routeur. Couleur de fond
  selon le status (vert=running, rouge=stopped, orange=paused, gris=unknown).
- **Vue détail** (tap sur une carte) : plein écran, scroll vertical. Métriques,
  graphiques (rrddata tracés en canvas), panel Grafana embarqué (option), logs
  Loki. Retour via bouton « ‹ retour », touche `Esc`, ou swipe vers le bas.
- **Backend proxy** : le token API Proxmox reste côté serveur. Le frontend ne
  parle qu'au backend (une seule origine, zéro CORS). Poll toutes les 3 s.

```
Navigateur (kiosque)
      │  fetch same-origin (poll 3s)
      ▼
Backend Express  ──►  PVE API   https://192.168.20.2:8006  (token, cert ignoré)
   (LXC 200)     ──►  Prometheus http://…:9090   (cartes NAS / routeur)
                 ──►  Loki       http://…:3100    (logs vue détail)
                 ──►  Grafana    http://…:3000    (iframe proxifiée /grafana)
```

## Arborescence

```
server/          backend Express (proxy PVE / Prometheus / Loki / Grafana)
  config.js      lecture des variables d'env + config/cards.json
  upstream.js    appels PVE (cert auto-signé ignoré), Prometheus, Loki
  index.js       routes API + service du frontend statique
public/          frontend (HTML/CSS/JS vanilla, aucune dépendance CDN)
config/cards.json  cartes externes (NAS, routeur) via requêtes Prometheus
Dockerfile / docker-compose.yml / .env.example
```

## Endpoints backend

| Route | Rôle |
|-------|------|
| `GET /api/config` | Config non-secrète pour le front (pollMs, node, grafana) |
| `GET /api/grid` | **Une seule** réponse agrégée : host + guests + NAS + routeur |
| `GET /api/rrd/node?timeframe=hour` | Séries temporelles du host PVE |
| `GET /api/rrd/:type/:vmid?timeframe=hour` | Séries d'un guest (`lxc`/`qemu`) |
| `GET /api/logs?host=<nom>&limit=150` | Logs Loki `{host="<nom>"}` |
| `/grafana/*` | Reverse-proxy vers Grafana (embed iframe) |

`/api/grid` est tolérant aux pannes : si une source échoue, la carte concernée
passe en `unknown` sans casser le reste.

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | `8080` | Port d'écoute du backend |
| `POLL_MS` | `3000` | Intervalle de poll du frontend |
| `PVE_HOST` | `192.168.20.2` | Host Proxmox |
| `PVE_PORT` | `8006` | Port API Proxmox |
| `PVE_NODE` | `pve` | Nom du node PVE |
| `PVE_TOKEN_ID` | — | ID du token API (`user@realm!nom`) |
| `PVE_TOKEN_SECRET` | — | Secret du token API |
| `PROM_URL` | `http://192.168.20.50:9090` | Prometheus |
| `LOKI_URL` | `http://192.168.20.50:3100` | Loki |
| `GRAFANA_URL` | `http://192.168.20.50:3000` | Grafana (vide = tab désactivé) |
| `LOKI_LABEL` | `host` | Label Loki pour filtrer les logs par machine |

Copier `.env.example` → `.env` et renseigner au minimum le token PVE.

## Token Proxmox read-only

Créer un utilisateur dédié, un rôle en lecture seule (`VM.Audit` + `Sys.Audit`,
plus `Datastore.Audit` pour voir le stockage), et un token. Sur le host PVE :

```sh
# 1) utilisateur dédié dans le realm PVE
pveum user add monitor@pve

# 2) rôle read-only (audit)
pveum role add Monitoring -privs "VM.Audit Sys.Audit Datastore.Audit"

# 3) droits sur toute l'arbo, en lecture
pveum acl modify / -user monitor@pve -role Monitoring

# 4) token SANS "privilege separation" pour qu'il hérite des droits du user
pveum user token add monitor@pve gui --privsep 0
```

La dernière commande affiche le **secret UNE seule fois** :

```
┌──────────────┬──────────────────────────────────────┐
│ key          │ value                                │
├──────────────┼──────────────────────────────────────┤
│ full-tokenid │ monitor@pve!gui                      │
│ value        │ xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  │
└──────────────┴──────────────────────────────────────┘
```

Reporter dans `.env` :

```
PVE_TOKEN_ID=monitor@pve!gui
PVE_TOKEN_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

> Le backend envoie `Authorization: PVEAPIToken=<id>=<secret>` et ignore le
> certificat auto-signé du `:8006` (uniquement pour les appels au host PVE).

## Cartes NAS & routeur (Prometheus)

Ces cartes ne viennent pas de l'API PVE mais de requêtes Prometheus instantanées
définies dans [`config/cards.json`](config/cards.json). Chaque carte fournit
jusqu'à 5 requêtes : `up` (1/0 → running/stopped), `cpu` (0..1), `mem` (octets),
`memMax` (octets), `uptime` (secondes).

**⚠️ Les noms de métriques dépendent de ton setup.** Les requêtes fournies sont
des points de départ plausibles (Synology via `snmp_exporter`/HOST-RESOURCES-MIB,
OPNsense via Telegraf). Vérifie les vrais noms dans l'explorateur Prometheus et
ajuste. Une requête vide/absente → le champ affiche `—`, la carte reste visible.

## Grafana embarqué (optionnel)

Le champ `grafana` de chaque carte (dans `cards.json` ; à ajouter aussi pour les
guests si tu veux) pointe vers une URL `/grafana/...` proxifiée par le backend.
Pour que l'iframe s'affiche, côté Grafana :

- `grafana.ini` → `[security] allow_embedding = true`
- pour éviter le login : `[auth.anonymous] enabled = true` (org Viewer), ou
  utiliser des liens de dashboard publics.
- URL de type `/grafana/d/<uid>/<slug>?kiosk&theme=dark&panelId=<n>`.

Dashboards de référence : **10347** (Proxmox), **14284** (Synology),
**OPNsense Cockpit**.

## Lancer

### En local (dev)

```sh
npm install
cp .env.example .env      # renseigner le token PVE
export $(grep -v '^#' .env | xargs)   # ou utiliser un loader d'env
npm start
# → http://localhost:8080
```

### Dans la LXC 200 (Docker, avec le stack existant)

Ajouter le service au `docker-compose.yml` du stack de monitoring (voir le
[`docker-compose.yml`](docker-compose.yml) fourni : il atteint Prometheus/Loki/
Grafana par leur nom de service, et le PVE par son IP host). Renseigner le token
dans le `.env` du stack, puis :

```sh
docker compose up -d --build proxmox-gui
# → http://192.168.20.50:8080
```

## Kiosque

Pointer le navigateur de l'écran 1U en plein écran sur l'URL, par ex. Chromium :

```sh
chromium --kiosk --incognito --noerrdialogs \
  --disable-pinch --overscroll-history-navigation=0 \
  --window-size=1424,280 http://192.168.20.50:8080
```

L'app ne stocke rien (aucun `localStorage`), tout l'état est en mémoire ; un
simple rechargement repart propre.
