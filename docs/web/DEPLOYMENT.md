# Deploying Nuvio Web

There are two independent parts:

| Part | Needs | Suitable hosts | Not suitable |
| --- | --- | --- | --- |
| Frontend (`dist-web/`) | Static HTTPS hosting | Cloudflare Pages, Netlify, Vercel, GitHub Pages | |
| Backend (`server/`) | Long-running process, disk, ffmpeg, inbound and outbound sockets | A VPS or a home server with Docker | Vercel, Cloudflare Workers, or any serverless platform: they kill long processes and can't hold swarm connections |

The frontend works without the backend for sources the browser can play directly. Torrents and MKV need it.

> The Docker files were written for this project but **haven't been run**, because Docker isn't installed
> on the development machine. The service they wrap is tested directly. Check them on first use.

## 1. Frontend

Set the variables in [`.env.example`](../../.env.example) in your host's build settings, then:

```bash
npm ci --ignore-scripts
npm run web:build
```

Publish `dist-web/`. Serve `sw.js`, `index.html` and `nuvio.env.js` with `Cache-Control: no-cache`,
because `app.js` isn't content-hashed and the service worker handles its versioning.

PWA install requires HTTPS, so it can't be tested over plain HTTP on a LAN address.

### Environments

Use one set of values per environment, kept in the host's settings and never committed:

| | development | staging | production |
| --- | --- | --- | --- |
| Frontend | `npm run web:dev` on `localhost:5173` | A preview URL | Your domain |
| Backend | `npm --prefix server run dev` | Separate instance and keys | Separate instance and keys |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | Preview URL | Your domain |

`server/scripts/dev.mjs` generates local secrets into `server/.env`, which git ignores.

### Connecting to the Nuvio account server

`NUVIO_SUPABASE_URL` and `NUVIO_SUPABASE_ANON_KEY` aren't in the upstream repository. Upstream injects
them into official releases from a CI secret, so a build without them can't reach existing accounts.
The login screen then offers a self-hosted server or guest mode. You need one of:

1. Values obtained from Nuvio Media, which is the cleanest route.
2. The values shipped in an official release. They're public client values by design, and the database's
   row-level security is what protects accounts. Using them from a third-party deployment may still not
   be something the project wants, so that's your decision.
3. Your own compatible server (`Use a self-hosted server` on the login screen).

Sign-in also needs the account server to accept requests from your frontend's origin. Supabase's REST and
auth APIs normally allow this, but the `tv-logins-exchange` edge function sets its own CORS rules. This
**hasn't been verified** against the official server. If it refuses browser origins, that's a blocker
that only Nuvio Media can change.

## 2. Backend

On a VPS with Docker, a domain pointing at it, and ports 80, 443 and 6881 open:

```bash
cd server
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"
# Put one generated value in ACCESS_KEYS and a different one in TOKEN_SECRET.
# Set BACKEND_DOMAIN and ALLOWED_ORIGINS.
docker compose up -d --build
```

Then in the app: **Settings → Streaming backend**, enter the URL and access key.

### Choosing a machine

- **CPU:** remuxing is light. Transcoding (`ALLOW_TRANSCODE=true`) needs several cores per stream.
- **Disk:** at least `MAX_CACHE_GB`. Pieces are written as they download.
- **Bandwidth:** both download from the swarm and upload to your phone count against provider limits.

### Before running a swarm client

Read this before exposing the service:

- **Your server's IP is visible to everyone in a swarm.** It both downloads and uploads pieces, as all
  BitTorrent clients do. You're responsible for what it transfers under your local law.
- **Check your provider's terms.** Many VPS providers prohibit BitTorrent or act on complaints.
- `TORRENT_UPLOAD_LIMIT_KBPS` limits uploading. Setting it to 0 can get you throttled by peers.

### Rotating secrets

- New `ACCESS_KEYS`: existing sessions keep working until they expire.
- New `TOKEN_SECRET`: signs everyone out at once and ends every stream link.

## 3. GPL-3.0

Nuvio Web is a modified version of a GPL-3.0 program. If you make the deployed app available to anyone
else, you're distributing it and must offer the corresponding source. That includes the JavaScript the
browser downloads. In practice:

- Make the repository public, or otherwise give every recipient access to the source. A private repository
  alone doesn't satisfy this once others use the app.
- Set `NUVIO_WEB_SOURCE_URL`, so **Settings → About** links to it.
- Keep `LICENSE` and [`NOTICE.md`](../../NOTICE.md).

Using it only yourself doesn't trigger these obligations.

## Running the tests

```bash
npm run test:server
```

```bash
npm run test:web
```

The browser suite needs Microsoft Edge (for H.264 and AAC decoders), ffmpeg, and `npx playwright install webkit`.

To check against a real public swarm, using the Creative Commons film *Sintel*:

```bash
node server/scripts/verify-public-torrent.mjs
```
