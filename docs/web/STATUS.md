# Nuvio Web status

What each word means here:

- **Tested**: an automated test exercised it in a real browser or against the real service.
- **Stand-in**: tested only against this project's mock account server or test addon.
- **Not verified**: written, but never run in the environment that matters.

**Real iPhone testing has started.** So far on one iPhone: sign-in and backend connection
work. Playback results are in "Real sources" below. Everything else marked Tested ran in Edge or in Playwright's
WebKit on Windows, which check scripts and layout but not iOS playback, safe areas or Home Screen behaviour.

## Blocked: needs a decision or something from you

| Item | What's missing |
| --- | --- |
| **Real iPhone testing** | Needs an HTTPS deployment and your phone. |
| **Production deployment** | Needs a static host, plus a VPS or home server for the backend. |

## Feature status

| Feature | Status | Evidence |
| --- | --- | --- |
| Device-code sign-in against the official server | **Tested with a real account** | Start, poll, approval and token exchange all worked, from `http://localhost:5173` only. A deployed domain hasn't been tried. |
| Reading a real account: profiles, addons, library, progress, settings | **Tested with a real account** | 2 profiles, 5 addons, Continue Watching and the resume position loaded |
| Writing to a real account | Not verified | Only tested on the mock. The real-account check blocked writes on purpose, and none were attempted. |
| Session refresh, expiry, sign-out | Stand-in | Mock server, using upstream's unchanged `AuthManager` |
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
| HLS through native Safari | Not verified | Only Apple devices use native HLS. Edge reports native support, but its parser rejected a real stream, so it uses hls.js. |
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

### Real sources from a real account

Tested in Edge on Windows, with the backend on the same PC, torrents off, and account writes blocked for the test.
One movie through AIOStreams returned 279 sources: 40 play directly, and the rest need the backend.

| Check | Result |
| --- | --- |
| Direct debrid link (720p), resuming from the synced position | **Played** |
| 67.9 GB 1080p source with TrueHD 7.1 audio, converted by the backend | **Played.** Started in about 15 seconds |
| Seek past the converted part, on that source | **Worked.** About 11 seconds |
| Audio track switch, on that source | **Worked.** About 7 seconds, and it kept its position |
| Subtitles from the OpenSubtitles addon | **Displayed.** Timing wasn't checked against the audio |
| First iPhone test, before fixes | "Direct" gave audio with no picture (consistent with MP4 HEVC tagged hev1, which is now converted). One "Needs backend" source failed, one played in about 60 seconds, and subtitles were sometimes out of time |
| Second iPhone test | "Direct" gave a decode error (HEVC remux had an empty hvcC, now fixed) and backend still took about a minute (long keyframe gaps made huge segments, now split by time) |
| Time until 3 segments are ready, measured on this PC with real sources, after those fixes | 11 to 16 seconds. Files the iPhone can play as they are: about 2 seconds to check. **The iPhone hasn't been retested**, so its total startup time and the HEVC fix are unconfirmed |
| Subtitle timing after fixes | Offset error fixed and tested with generated video. **Not confirmed on the iPhone.** A subtitle made for a different release of a film can still drift |

High-bitrate sources need real bandwidth from backend to phone: one 4-second segment of that source was about 18 MB, or roughly 36 Mbit/s.

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
