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

## Docker (local / CI)
```bash
# build & run locally
docker build -t vantage:ci .
docker run -d --name vtest -p 8181:8080 -e AUTO_SEED=1 vantage:ci   # auto-seeds when data/vantage.db absent
docker exec vtest node smoke.js                                       # 51/51 API checks inside the container
```

## CI/CD
`.github/workflows/ci.yml` runs on every push: build image → run container → `smoke.js` (51 checks) → Playwright suite (74 checks) vs the container.

Pushes to `main` **also deploy to the Azure VM** (SSH, no cloud APIs needed). Required GitHub settings:

| type | name | value |
|---|---|---|
| var | `VM_DEPLOY` | `1` (gate — deploy job only runs when set) |
| secret | `VM_HOST` | VM IP or hostname, e.g. `158.158.0.87` |
| secret | `VM_KEY` | full contents of the VM SSH private key (`Get-Content key.pem -Raw`) |

The deploy job uploads the repo (minus `.git`/`data`/`node_modules`/`stock-videos`), reinstalls the systemd unit, restarts `vantage.service` and verifies `http://<VM_HOST>/api/health`. Live data in `data/` is preserved.

## Deploy to a VM (manual, what CI automates)
```powershell
cd D:\vantage\deploy
.\deploy.ps1 -HostName <IP> -Key <path\to\key.pem>
```
Installs `/etc/systemd/system/vantage.service` (User=azureuser, WorkingDirectory=/home/azureuser/vantage, port 80 with `CAP_NET_BIND_SERVICE`, auto-restart). Requires Node >= 22.5 on the VM (the script verifies node:sqlite first). Files land in `/home/azureuser/vantage/`, stock clips in `/home/azureuser/stock-videos/`. The first boot auto-seeds canonical users (`admin/admin123`, `creator1/creator123`, `viewer1/viewer123`) and the stock clips; seed is idempotent and enforces the canonical account set on every start.

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
