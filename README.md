# Vantage — every frame counts.

Zero-dependency Node video platform (node:http + node:sqlite + node:crypto — no npm packages).

## Run locally
```bash
STOCK_DIR=D:\stock-videos VANTAGE_DATA=D:\vantage\.data node seed.js   # idempotent, per-clip failure-safe
VANTAGE_DATA=D:\vantage\.data node server.js                            # listens on :8080 (PORT env)
```
Node >= 22.5 required (node:sqlite). Seed generates thumbs with ffmpeg when available, else placeholder SVGs (which also serve as 200-status placeholders for missing thumbs — no 404 noise).

## Verify
- `node smoke.js` — 51 API checks (spawns its own server on :8181, fresh data dir).
- Suite: `node tests/vantage-agg.cjs` — 74 end-to-end checks (API + desktop + mobile + creator/admin). Spawns its own server; point at a deployed instance with `VB=https://<fqdn>`, `AGG_DATA`/`STOCK_DIR` for external targets (playwright devDependency required: `npm i -D playwright && npx playwright install chromium`).

## Accounts (seeded)
| user | password | role |
|---|---|---|
| admin | admin123 | admin |
| creator1 | creator123 | creator |
| viewer1 | viewer123 | consumer |

## Features
- Feed with autoplay, sound toggle, keyboard navigation (↑/↓)
- Watch page: range streaming, resume chip, Up-Next countdown auto-advance (5s, click to cancel), view counting
- Consumer: comments, 5-star ratings (tap same star again to unrate), like, watch progress resume, personal playlists (create/add/remove/play-all)
- Creator: upload (drag&drop, progress bar), analytics bars (views/likes/comments), edit/delete, admin-provisioned accounts
- Admin: platform stats, provision/deprovision creators
- Keyboard on watch: Space play/pause, ←/→ seek ±5s, Esc back to feed
- Data: `data/vantage.db` (SQLite WAL), uploads and ffmpeg thumbs under `data/`

## Deploy with Docker / Azure Container Apps
```bash
# build & run locally
docker build -t vantage:ci .
docker run -d --name vtest -p 8181:8080 -e AUTO_SEED=1 vantage:ci   # auto-seeds when data/vantage.db absent
docker exec vtest node smoke.js                                       # 51/51 API checks inside the container
```

Pushing to Azure is handled by `.github/workflows/ci.yml` — every push runs the full suite (build → run → `smoke.js` → Playwright suite vs the container); pushes to `main` additionally deploy to Azure Container Apps via ACR. Required GitHub secrets/vars:

| type | name | value |
|---|---|---|
| secret | `AZURE_CREDENTIALS` | service principal JSON (`az ad sp create-for-rbac --name vantage-cicd --role owner --scopes /subscriptions/<sub>`) |
| var | `REGISTRY` | e.g. `vantageci.azurecr.io` |
| var | `REGISTRY_NAME` | registry login server for the app image |
| var | `AZURE_RESOURCE_GROUP` | e.g. `vantage-rg` |
| var | `CONTAINER_APP_ENV` | environment name, e.g. `vantage-env` |
| var | `CONTAINER_APP` | app name, e.g. `vantage-app` |
| var | `AZURE_LOCATION` (optional) | default `westeurope` |

Deployed data lives in the container's writable layer — ephemeral and auto-seeded at first boot. For durability, attach Azure Files (`az containerapp volume add` / `-v` with `--secret-volume-mount`) and map `data/`.

Manual deploy (same steps the workflow runs):
```powershell
az login
az group create -n $env:AZURE_RESOURCE_GROUP -l westeurope
az acr create -g $env:AZURE_RESOURCE_GROUP -n $env:REGISTRY_NAME --sku Basic
az acr login -n $env:REGISTRY_NAME
docker tag vantage:ci $env:REGISTRY/vantage:latest; az acr import -n $env:REGISTRY_NAME --source $env:REGISTRY/vantage:latest
az containerapp env create -g $env:AZURE_RESOURCE_GROUP -n $env:CONTAINER_APP_ENV -l westeurope
az containerapp create -g $env:AZURE_RESOURCE_GROUP -n $env:CONTAINER_APP --environment $env:CONTAINER_APP_ENV `
  --image $env:REGISTRY/vantage:latest --ingress external --target-port 8080 --cpu 0.5 --memory 1Gi --min-replicas 1 --max-replicas 3
```
Verify: `az containerapp show ... --query properties.configuration.ingress.fqdn` → open `https://<fqdn>/`.

## Deploy to a VM (legacy, superseded by Docker/ACA)
```powershell
cd D:\vantage\deploy
.\deploy.ps1 -Host <IP> -Key <path\to\key.pem>
```
Installs `/etc/systemd/system/vantage.service` (User=azureuser, WorkingDirectory=/home/azureuser/vantage, port 8080, auto-restart). Requires Node >= 22.5 on the VM (the script verifies node:sqlite first). Files land in `/home/azureuser/vantage/`, stock clips in `/home/azureuser/stock-videos/`.

## API surface
- `GET /api/videos?q=&genre=&sort=latest|popular|rating&limit=` (+ `myRating` when authed)
- `GET /api/videos/:id` (includes `myRating`, `progress` when authed), `/related`, `/stream` (range), `/thumb` (jpg or placeholder SVG — always 200)
- `GET|POST /api/videos/:id/comments`, `DELETE /api/comments/:id`
- `POST /api/videos/:id/rating` (stars 1-5, 0 = remove), `/view`
- `GET|PUT /api/videos/:id/progress` (consumer)
- `GET|POST /api/me/playlists` (`?videoId=` adds `containsVideo`), `GET /api/playlists/:id`, `POST|DELETE .../items`
- `POST /api/videos` (creator/admin, raw body upload with query metadata), `PATCH|DELETE /api/videos/:id`
- `GET /api/me/videos` (creator/admin), `GET|POST|DELETE /api/admin/creators`, `GET /api/admin/stats`
- `POST /api/auth/register` (consumer), `POST /api/auth/login` — HMAC-signed bearer tokens, scrypt password hashing
