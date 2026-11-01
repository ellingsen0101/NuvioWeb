# Nuvio Web status

What each word means here:

- **Tested**: an automated test exercised it in a real browser or against the real service.
- **Stand-in**: tested only against this project's mock account server or test addon.
- **Not verified**: written, but never run in the environment that matters.

**Nothing has been run on a real iPhone or in iOS Safari.** The closest available was Playwright's WebKit
on Windows with an iPhone profile, which checks scripts and layout but not playback, safe areas or Home
Screen behaviour.

## Blocked: needs a decision or something from you

| Item | What's missing |
| --- | --- |
| **Real Nuvio account sign-in** | Starting sign-in and polling work against the official server from a browser origin (`http://localhost:5173`). Approving a code, the token exchange, and syncing a real account are **not verified yet**: they need the account owner to approve a code. The server values are in git-ignored `local.properties`, taken from the official 1.3.0 release. |
| **Real iPhone testing** | Needs an HTTPS deployment and your phone. |
| **Production deployment** | Needs a static host, plus a VPS or home server for the backend. |

## Feature status

| Feature | Status | Evidence |
| --- | --- | --- |
| Device-code sign-in, QR, session refresh, expiry, sign-out | Stand-in | Mock server, using upstream's unchanged `QrLoginService` and `AuthManager` |
| Profiles: list, choose, add | Stand-in | Sync push checked |
| Profiles: edit, delete, PIN | Not verified | Written, with no test yet |
| Addon sync from account | Stand-in | Unavailable addons are handled |
| Add, remove, reorder, disable and update addons, bad URLs | Tested | Against the local test addon |
| Catalogs and metadata | **Tested against live Cinemeta** | |
| Search | Stand-in test addon | |
| Series, seasons, episodes | **Tested against live Cinemeta** | |
| Continue Watching, resume | Tested | Local, and pushed to the mock |
| Library, with sync push | Stand-in | |
| Watched marks on episodes | Stand-in | Sync push checked |
| MP4 playback, seeking | Tested in Edge | |
| HLS through hls.js | Tested in Edge | |
| HLS through native Safari | Not verified | |
| MKV remux to HLS, seeking past converted part | Tested in Edge | |
| Audio track listing | Tested for remuxed streams | Switching tracks is not verified |
| Subtitles from addons, timing control | Tested | Live OpenSubtitles addon not exercised |
| Fullscreen, landscape, PiP, wake lock | Not verified | Depends on device behaviour |
| iPhone native fullscreen with subtitles | Not verified | |
| Picture-in-picture | Not verified | |
| Debrid (direct link resolving) | Not verified | Wired to upstream's resolver. Needs a provider account, and provider CORS is unknown |
| PWA manifest, icons, service worker, offline shell | Tested in Edge | |
| Add to Home Screen on iOS | Not verified | |
| Phone and desktop layouts | Tested | No sideways scrolling on main screens |
| Accent themes | Tested | Upstream's theme system |

### Torrent streaming

| Check | Result |
| --- | --- |
| Local swarm: correct bytes at any offset, compared by hash | Tested |
| Local swarm through the browser UI: MP4 direct, MKV remuxed | Tested in Edge |
| Real public swarm: *Sintel* (CC BY 3.0), production security settings | **Passed.** Ready in 2 to 4 seconds with 9 peers, seek read returned correct size, ffprobe saw H.264 and AAC. Run with `server/scripts/verify-public-torrent.mjs`. |
| Real addon such as Torrentio | **Not tested.** The stream format it uses is implemented (`infoHash`, `fileIdx`, `sources`), but it was deliberately not run, since its results are mostly copyrighted releases. |
| Long playback, poorly seeded swarms | Not verified |

### Backend security

Tested in `server/test/`: every route rejects missing and bad tokens, login rate limits, CORS allowlist,
internal targets refused without contact (including IPv6 and numeric forms), token scoping, session limits
and abandoned-session eviction, playlist token rewriting, and input validation.

Not tested: a real DNS rebinding attack, or load.

## Not ported

These exist in the TV app but not here yet. They're not hidden behind broken UI.

| Feature | Note |
| --- | --- |
| Plugins (JS scrapers) | Upstream's runtime depends on a service on the TV. Plugin streams won't appear. |
| Trakt, Simkl, MDBList sign-in screens | Their sync code is present, but there's no UI to connect them. |
| Debrid account setup | Credentials sync from the account, but can't be entered here. |
| Watch party, trailers, ratings badges, skip intro, collections, media servers, post-play recommendations | Not ported. |
| Embedded subtitles from MKV | Not extracted. Sidecar and addon subtitles work. |
| Translated UI | New screens are English only. Upstream's translations load but aren't wired to them. |
| HLS sources that need custom headers | Refused by the backend, with an error. |

## Platform limits, which code can't remove

- **iPhone Safari can't play MKV, and can't join swarms.** Hence the backend.
- **iPhone only allows fullscreen on the video element.** While in it, the system player replaces the custom
  controls and custom subtitle rendering. The app mirrors subtitles into a native text track for this.
- **Autoplay without a tap can be refused** on iOS. The player then waits with its play button showing.
- **Hardware support decides HEVC.** Without decoding support and with transcoding off, the backend refuses
  and explains why.
- **HLS remux seeking restarts ffmpeg** when the target isn't converted yet, so it takes a moment and depends
  on swarm speed.

## Known issues

- `npm audit` reports 4 high findings in `server/`, all from one advisory on the `ip` package, through
  `webtorrent` → `bittorrent-tracker`. Its only use there is in the tracker's UDP **server** code, which this
  project doesn't run, and the SSRF guard doesn't use that package. npm's only offered fix is a downgrade to a
  2016 WebTorrent release, so this is accepted for now.
- One test (`touch targets` in WebKit) failed once in a full run, then passed 5 of 5 alone and in every later full run. Cause not found.
- The Docker and CI files haven't been run.
