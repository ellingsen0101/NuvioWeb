# Nuvio Web architecture

## What upstream is

NuvioTVSmart (v1.3.0 at the fork point, 1,217 commits) is a vanilla JavaScript single-page app for
Samsung Tizen and LG webOS TVs, with no UI framework. Roughly:

| Area | Location | Portable to a browser? |
| --- | --- | --- |
| Auth, sync, profiles | `js/core/auth`, `js/core/profile`, `js/core/sync` | Yes, used unchanged |
| Addons, catalogs, meta, streams, subtitles, progress | `js/data/repository`, `js/data/remote`, `js/data/local` | Yes, used unchanged |
| Debrid resolving | `js/core/debrid` | Yes, used unchanged |
| Themes and translations | `js/ui/theme`, `js/i18n`, `res/` | Yes, used unchanged |
| TV screens and D-pad focus navigation | `js/ui/screens` (379 files), `js/ui/navigation` | No: built around a remote and a 1920x1080 canvas |
| Player | `js/core/player`, `js/ui/screens/player` | Mostly no: built around Tizen AVPlay and webOS media pipelines |
| Local torrent service | `services/tizen`, `services/webos` | No: a vendored service that runs on the TV itself |
| Platform layer | `js/platform` | Already has a `browser` adapter, used as is |

Account data lives in a Supabase project. Its URL and public key are not in the repository: upstream
injects them at release time from a CI secret (`NUVIO_LOCAL_PROPERTIES`).

## What this port does

```
                       ┌──────────────────────────────┐
  browser / PWA        │ web/  new touch-first UI      │
                       │   screens, player, router     │
                       ├──────────────────────────────┤
                       │ js/   upstream logic, as is   │
                       └──┬───────────┬───────────┬───┘
                          │           │           │
              account server     addons (direct,   server/  separate backend
              (Supabase: auth,   or through the    (torrents, remux, proxy)
              profiles, sync)    backend on CORS   needs: long-running process,
                                 failure)          disk, ffmpeg, open sockets
```

**Upstream code is imported, not copied.** `js/`, `css/`, `res/`, `services/` and the TV build stay as
they were, so `git merge upstream/main` keeps working. New code is in `web/`, `server/`,
`scripts/web-*.mjs` and `docs/web/`. The only upstream files changed are `package.json` (scripts and
test dependencies), `.gitignore` and `README.md`.

**The UI is new, because the TV UI can't be adapted.** Its layout assumes a fixed canvas and its
interaction assumes focus and a remote. The new screens reuse its colour tokens, theme system, logos,
fonts and structure (hero, rows, detail page, profile picker) with touch-first layouts.

### Platform abstraction

| Concern | TV | Web |
| --- | --- | --- |
| Input | `FocusEngine`, D-pad | Touch, mouse, keyboard shortcuts in the player |
| Navigation | `Router` with TV back handling | `web/src/lib/router.js`, hash based, so any static host works |
| Video | AVPlay, webOS media | `<video>`, native HLS on Safari, hls.js elsewhere |
| Torrents | Local EngineFS service on the TV | `server/` backend, reached over HTTPS |
| Sign-in | Device code with QR | The same flow and the same `QrLoginService` |
| CORS failures | Companion service proxy | Authenticated backend proxy, as a fallback |

`web/src/services/addonFetch.js` wraps `fetch` for the CORS fallback instead of editing upstream's
`httpClient`. That's the same seam where upstream plugs in its webOS Supabase proxy.

## Torrent playback

A browser can't open BitTorrent connections, and iOS Safari has neither WebRTC data channels suited to
this nor standard MSE on iPhone. WebTorrent in the browser only reaches WebRTC peers, which most
torrents don't have. So the swarm is reached by a server and the phone receives ordinary HTTP video:

1. The app sends the info hash, addon-provided trackers and episode hints to the backend.
2. The backend joins the swarm with WebTorrent, gets metadata, and picks the file: explicit index,
   then filename hint, then season and episode match, then largest video.
3. `ffprobe` reads the file through the backend's own loopback endpoint.
4. `decidePlayback` compares its codecs with what the device reported:

| Source | Result |
| --- | --- |
| MP4 with H.264 (8-bit) or device-supported HEVC, and playable audio | Direct, with HTTP Range requests |
| MKV etc. with H.264 | HLS remux (video copied, audio to AAC where needed) |
| MKV etc. with HEVC, on devices that decode it | HLS remux with fMP4 segments |
| HEVC on devices that can't, 10-bit H.264, other codecs | Transcode if `ALLOW_TRANSCODE=true`, otherwise a clear error |

Seeking in HLS mode: if the target is outside what's been converted, the backend restarts ffmpeg at that
time and the player keeps a time offset, so its timeline, progress and subtitles stay in file time.

## Backend security

- **No anonymous use.** The service refuses to start without `ACCESS_KEYS` and `TOKEN_SECRET`.
- **Sessions.** An access key is exchanged for a signed session token. The key itself is never stored
  in the browser. Login attempts are limited to 5 per minute per IP.
- **Media URLs** carry a token scoped to one playback session, because `<video>` can't send headers.
  Tokens from one session can't read another, and they die with the session.
- **SSRF.** All outbound requests are checked inside the socket's DNS lookup, so the checked address is
  the connected address, which closes DNS rebinding. Redirects are rechecked at each hop. IPv4-mapped
  IPv6 and numeric host forms are covered.
- **No open proxy.** The proxy accepts only addon-protocol paths and subtitle paths, with size and time
  limits. It isn't a general URL fetcher.
- **ffmpeg can't reach the network freely.** It reads only the loopback file endpoint, with its input
  protocols limited to `http,tcp`.
- **Swarm input is untrusted.** Web seeds are disabled, addon trackers pointing at internal hosts are
  dropped, and peers in private ranges are blocked. Only 40-hex info hashes are accepted, not raw magnets.
- **Limits.** Sessions, torrents, ffmpeg processes, connections, file size and cache size are capped.
  Idle sessions and unused torrents are removed along with their data. CORS is an exact-origin allowlist.
- **Logs** never include tokens or query strings. Caddy's access log is off because URLs carry tokens.

## Frontend security

- Addon-supplied text is rendered with `textContent`, never as HTML. Artwork and links must be http(s).
- A Content Security Policy blocks inline and third-party scripts. `connect-src`, `img-src` and
  `media-src` stay open because addons can live anywhere.
- Session tokens are in `localStorage`, using upstream's `SessionStore`. Any XSS could read them, which
  is why the two points above matter.
- Stream URLs may embed debrid or addon credentials, so they're kept in memory only, never in the URL
  or in storage. That's why a reload on the player returns to the title.
- The service worker stores only same-origin app files, translations and public config. It never stores
  account responses, addon responses or media.

## Bundle

esbuild output, gzipped: about 210 KB for the app. hls.js (about 170 KB gzipped) loads only where the
browser has no native HLS, so iPhones don't download it. Code splitting is off because upstream's many
small dynamic imports became 60+ requests at startup.
