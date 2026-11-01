// Local stack for browser tests. Everything here is a stand-in that runs on this machine:
//   - a mock account server shaped after the requests upstream's code makes (it does not prove the
//     real Nuvio backend behaves the same way)
//   - a Stremio-protocol addon serving generated test videos
//   - a BitTorrent tracker and seeder sharing a generated test video
//   - the production build of the frontend and the real backend from server/
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const mediaDir = path.join(rootDir, ".cache", "e2e-media");
const distDir = path.join(rootDir, ".cache", "e2e-dist");
export const PORTS = { app: 6200, fixture: 6100, tracker: 6101, backend: 6300 };
export const BACKEND_KEY = "e2e-access-key-only-for-local-tests";
const FIXTURE = `http://localhost:${PORTS.fixture}`;
const DURATION_SECONDS = 90;

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
}

function generateMedia() {
  mkdirSync(path.join(mediaDir, "hls"), { recursive: true });
  const input = [
    "-f", "lavfi", "-i", `testsrc2=size=426x240:rate=24:duration=${DURATION_SECONDS}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${DURATION_SECONDS}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p"
  ];
  const mp4 = path.join(mediaDir, "direct.mp4");
  if (!existsSync(mp4)) ffmpeg([...input, "-c:a", "aac", "-movflags", "+faststart", mp4]);
  const torrentMp4 = path.join(mediaDir, "torrent-video.mp4");
  if (!existsSync(torrentMp4)) ffmpeg([...input, "-c:a", "aac", "-metadata", "title=torrent", "-movflags", "+faststart", torrentMp4]);
  const mkv = path.join(mediaDir, "remux.mkv");
  if (!existsSync(mkv)) ffmpeg([...input, "-c:a", "ac3", mkv]);
  const longGop = path.join(mediaDir, "longgop.mkv");
  if (!existsSync(longGop)) ffmpeg([...input, "-c:a", "ac3", "-g", "240", "-keyint_min", "240", "-sc_threshold", "0", longGop]);
  const torrentMkv = path.join(mediaDir, "torrent-remux.mkv");
  if (!existsSync(torrentMkv)) ffmpeg([...input, "-c:a", "ac3", "-metadata", "title=torrent-mkv", torrentMkv]);
  const playlist = path.join(mediaDir, "hls", "index.m3u8");
  if (!existsSync(playlist)) {
    ffmpeg([...input, "-c:a", "aac", "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod", "-hls_segment_filename", path.join(mediaDir, "hls", "seg%03d.ts"), playlist]);
  }
}

function fakeJwt(subject, ttlSeconds = 3600) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub: subject, exp: Math.floor(Date.now() / 1000) + ttlSeconds })}.mock`;
}

const SUBTITLE = `1
00:00:01,000 --> 00:00:30,000
Nuvio test subtitle line

2
00:00:31,000 --> 00:01:30,000
Second subtitle line
`;

function createFixtureServer({ torrentHashes }) {
  const state = {
    approved: false,
    pushes: {},
    addonUrl: `${FIXTURE}/addon`,
    expireNext: false,
    tokensIssued: 0,
    refreshes: 0
  };
  const addonManifest = {
    id: "com.nuvio.e2e",
    name: "E2E Test Addon",
    version: "1.0.0",
    description: "Generated test videos for automated tests.",
    resources: ["catalog", "meta", "stream", "subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["e2e"],
    catalogs: [
      { id: "e2e-movies", type: "movie", name: "E2E Movies", extra: [{ name: "search" }, { name: "skip" }] },
      { id: "e2e-series", type: "series", name: "E2E Series" }
    ]
  };
  const movieNames = ["Direct MP4", "HLS Stream", "MKV Remux", "Torrent MP4", "Torrent MKV", "Long Keyframe MKV"];
  const toMeta = (name, index) => ({
    id: `e2e-movie-${index}`,
    type: "movie",
    name,
    poster: `${FIXTURE}/art/poster.svg`,
    background: `${FIXTURE}/art/background.svg`,
    description: `Automated test title: ${name}.`,
    releaseInfo: "2026",
    genres: ["Test"]
  });
  const series = {
    id: "e2e-series-1",
    type: "series",
    name: "Test Series",
    poster: `${FIXTURE}/art/poster.svg`,
    background: `${FIXTURE}/art/background.svg`,
    description: "Automated test series.",
    videos: [1, 2].map((episode) => ({ id: `e2e-series-1:1:${episode}`, season: 1, episode, title: `Episode ${episode}`, released: "2026-01-01T00:00:00.000Z" }))
  };
  const tracker = `tracker:http://localhost:${PORTS.tracker}/announce`;
  const streamsFor = (id) => {
    if (id === "e2e-movie-0" || id.startsWith("e2e-series-1:")) return [{ name: "E2E\nDirect", title: "direct.mp4", url: `${FIXTURE}/media/direct.mp4`, behaviorHints: { filename: "Direct.1080p.WEB-DL-E2E.mp4" } }];
    if (id === "e2e-movie-1") return [{ name: "E2E\nHLS", title: "index.m3u8", url: `${FIXTURE}/media/hls/index.m3u8` }];
    if (id === "e2e-movie-2") return [{ name: "E2E\nMKV", title: "remux.mkv", url: `${FIXTURE}/media/remux.mkv` }];
    if (id === "e2e-movie-5") return [{ name: "E2E\nMKV", title: "longgop.mkv", url: `${FIXTURE}/media/longgop.mkv` }];
    if (id === "e2e-movie-3") return [{ name: "E2E\nTorrent", title: "torrent-video.mp4", infoHash: torrentHashes.mp4, sources: [tracker] }];
    if (id === "e2e-movie-4") return [{ name: "E2E\nTorrent", title: "torrent-remux.mkv", infoHash: torrentHashes.mkv, sources: [tracker] }];
    return [];
  };

  function sendJson(response, status, body) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }

  async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      return {};
    }
  }

  function serveMedia(request, response, pathname) {
    const file = path.join(mediaDir, pathname.replace(/^\/media\//, ""));
    if (!file.startsWith(mediaDir) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    const size = statSync(file).size;
    const type = file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : file.endsWith(".ts") ? "video/mp2t" : file.endsWith(".mkv") ? "video/x-matroska" : "video/mp4";
    const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range || "");
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      response.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": size });
    createReadStream(file).pipe(response);
  }

  async function handleAccountServer(request, response, url) {
    const { pathname } = url;
    const bearer = String(request.headers.authorization || "").replace(/^Bearer /, "");
    const issue = (subject) => {
      state.tokensIssued += 1;
      return { access_token: fakeJwt(subject), refresh_token: `refresh-${subject}-${state.tokensIssued}`, token_type: "bearer" };
    };
    if (pathname === "/auth/v1/signup") return sendJson(response, 200, issue("anon"));
    if (pathname === "/auth/v1/token") {
      const body = await readBody(request);
      if (url.searchParams.get("grant_type") === "refresh_token") {
        state.refreshes += 1;
        if (state.rejectRefresh) return sendJson(response, 400, { error: "invalid_grant", error_description: "Invalid Refresh Token" });
        return sendJson(response, 200, issue(String(body.refresh_token || "").includes("anon") ? "anon" : "user-1"));
      }
      return sendJson(response, 200, issue("anon"));
    }
    if (pathname === "/functions/v1/tv-logins-exchange") return sendJson(response, 200, issue("user-1"));
    if (state.expireNext && pathname.startsWith("/rest/v1/") && bearer.includes(".")) {
      state.expireNext = false;
      return sendJson(response, 401, { code: "PGRST301", message: "JWT expired" });
    }
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(pathname)?.[1];
    if (rpc) {
      const body = await readBody(request);
      if (rpc.startsWith("sync_push_")) state.pushes[rpc] = body;
      switch (rpc) {
        case "start_device_login_session":
          state.loginStarts = (state.loginStarts || 0) + 1;
          return sendJson(response, 200, [{ device_code: "device-1", user_code: "ABCD-1234", verification_uri: `${FIXTURE}/link`, verification_uri_complete: `${FIXTURE}/link?code=ABCD-1234`, expires_at: new Date(Date.now() + 600000).toISOString(), poll_interval_seconds: 1 }]);
        case "poll_tv_login_session":
          return sendJson(response, 200, [{ status: state.approved ? "approved" : "pending", poll_interval_seconds: 1 }]);
        case "get_sync_owner":
          return sendJson(response, 200, "user-1");
        case "sync_pull_profiles":
          return sendJson(response, 200, [{ profile_index: 1, name: "Account Owner", is_primary: true }, { profile_index: 2, name: "Second Person", avatar_color_hex: "#8E24AA" }]);
        case "sync_pull_profile_locks":
          return sendJson(response, 200, []);
        case "sync_pull_library":
          return sendJson(response, 200, [{ content_id: "e2e-movie-1", content_type: "movie", name: "HLS Stream", poster: `${FIXTURE}/art/poster.svg`, added_at: Date.now() }]);
        default:
          return sendJson(response, 200, []);
      }
    }
    if (pathname === "/rest/v1/addons") return sendJson(response, 200, [{ url: state.addonUrl, sort_order: 0, enabled: true }, { url: "https://unavailable-addon.invalid", sort_order: 1, enabled: true }]);
    if (pathname.startsWith("/rest/v1/")) return sendJson(response, 200, []);
    return false;
  }

  return {
    state,
    server: http.createServer(async (request, response) => {
      const url = new URL(request.url, FIXTURE);
      const { pathname } = url;
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Headers", "*");
      response.setHeader("Access-Control-Allow-Methods", "*");
      response.setHeader("Access-Control-Expose-Headers", "*");
      if (request.method === "OPTIONS") {
        response.writeHead(204).end();
        return;
      }
      if (pathname === "/__test/approve") {
        state.approved = true;
        return sendJson(response, 200, { ok: true });
      }
      if (pathname === "/__test/state") return sendJson(response, 200, state);
      if (pathname === "/__test/reset") {
        Object.assign(state, { approved: false, pushes: {}, expireNext: false, rejectRefresh: false, refreshes: 0, loginStarts: 0 });
        return sendJson(response, 200, { ok: true });
      }
      if (pathname === "/__test/expire") {
        state.expireNext = true;
        return sendJson(response, 200, { ok: true });
      }
      if (pathname === "/__test/reject-refresh") {
        state.rejectRefresh = true;
        state.expireNext = true;
        return sendJson(response, 200, { ok: true });
      }
      if (pathname === "/addon/manifest.json") return sendJson(response, 200, addonManifest);
      if (pathname.startsWith("/addon/catalog/series/")) return sendJson(response, 200, { metas: [series] });
      if (pathname.startsWith("/addon/catalog/movie/")) {
        const search = /search=([^/.]+)/.exec(decodeURIComponent(pathname))?.[1]?.toLowerCase();
        const metas = movieNames.map(toMeta).filter((meta) => !search || meta.name.toLowerCase().includes(search));
        return sendJson(response, 200, { metas });
      }
      const metaMatch = /^\/addon\/meta\/(movie|series)\/(.+)\.json$/.exec(pathname);
      if (metaMatch) {
        const id = decodeURIComponent(metaMatch[2]);
        if (id === series.id) return sendJson(response, 200, { meta: series });
        const index = Number(id.replace("e2e-movie-", ""));
        return sendJson(response, 200, { meta: movieNames[index] ? toMeta(movieNames[index], index) : null });
      }
      const streamMatch = /^\/addon\/stream\/(?:movie|series)\/(.+)\.json$/.exec(pathname);
      if (streamMatch) return sendJson(response, 200, { streams: streamsFor(decodeURIComponent(streamMatch[1])) });
      if (pathname.startsWith("/addon/subtitles/")) {
        // The first track is for another release, as real addons often list. The player has to skip it.
        return sendJson(response, 200, {
          subtitles: [
            { id: "e2e-wrong", url: `${FIXTURE}/subs/wrong-release.srt`, lang: "eng", title: "Other.Movie.Theatrical.720p.HDTV-NOPE" },
            { id: "e2e-en", url: `${FIXTURE}/subs/english.srt`, lang: "eng", title: "Direct.1080p.WEB-DL-E2E" }
          ]
        });
      }
      if (pathname.endsWith(".srt")) {
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(pathname.includes("wrong") ? SUBTITLE.replaceAll("subtitle line", "wrong release line") : SUBTITLE);
        return;
      }
      if (pathname.startsWith("/art/")) {
        const [width, height, color] = pathname.includes("poster") ? [300, 450, "#4d55e8"] : [1280, 720, "#22314d"];
        response.writeHead(200, { "Content-Type": "image/svg+xml" });
        response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`);
        return;
      }
      if (pathname.startsWith("/media/")) return serveMedia(request, response, pathname);
      const handled = await handleAccountServer(request, response, url);
      if (handled === false) response.writeHead(404).end();
    })
  };
}

function serveStatic(directory, port) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };
  return new Promise((resolve) => {
    http
      .createServer((request, response) => {
        const pathname = new URL(request.url, "http://x").pathname;
        const file = path.join(directory, pathname === "/" ? "index.html" : pathname);
        if (!file.startsWith(directory) || !existsSync(file) || !statSync(file).isFile()) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
        createReadStream(file).pipe(response);
      })
      .listen(port, resolve);
  });
}

async function startSwarm() {
  const modules = path.join(rootDir, "server", "node_modules");
  const { default: TrackerServer } = await import(pathToFile(path.join(modules, "bittorrent-tracker", "server.js")));
  const tracker = new TrackerServer({ udp: false, ws: false, http: true, stats: false, filter: (hash, params, cb) => cb(null) });
  await new Promise((resolve) => tracker.listen(PORTS.tracker, "127.0.0.1", resolve));
  const { default: WebTorrent } = await import(pathToFile(path.join(modules, "webtorrent", "index.js")));
  const seeder = new WebTorrent({ dht: false, lsd: false, utp: false, webSeeds: false, natUpnp: false, natPmp: false });
  const seed = (file) =>
    new Promise((resolve) => {
      seeder.seed(file, { announce: [`http://127.0.0.1:${PORTS.tracker}/announce`] }, (torrent) => resolve(torrent.infoHash));
    });
  return {
    mp4: await seed(path.join(mediaDir, "torrent-video.mp4")),
    mkv: await seed(path.join(mediaDir, "torrent-remux.mkv"))
  };
}

function pathToFile(value) {
  return new URL(`file:///${String(value).replace(/\\/g, "/")}`).href;
}

async function main() {
  generateMedia();

  Object.assign(process.env, {
    NUVIO_SUPABASE_URL: FIXTURE,
    NUVIO_SUPABASE_ANON_KEY: "e2e-anon-key",
    // Set explicitly so that a developer's local.properties can never point tests at a real server.
    NUVIO_SUPABASE_FALLBACK_URL: "",
    AVATAR_PUBLIC_BASE_URL: "",
    TV_LOGIN_WEB_BASE_URL: `${FIXTURE}/tv-login`,
    DEVICE_LOGIN_WEB_BASE_URL: `${FIXTURE}/link`,
    NUVIO_BACKEND_URL: `http://localhost:${PORTS.backend}`
  });
  const { buildWeb } = await import(pathToFile(path.join(rootDir, "scripts", "web-build.mjs")));
  await buildWeb({ outDir: distDir });
  await serveStatic(distDir, PORTS.app);

  const torrentHashes = await startSwarm();
  const { server } = createFixtureServer({ torrentHashes });
  await new Promise((resolve) => server.listen(PORTS.fixture, resolve));

  const backend = spawn(process.execPath, ["src/index.js"], {
    cwd: path.join(rootDir, "server"),
    stdio: "inherit",
    env: {
      ...process.env,
      ACCESS_KEYS: BACKEND_KEY,
      TOKEN_SECRET: "e2e-token-secret-only-for-local-tests-0123456789",
      ALLOWED_ORIGINS: `http://localhost:${PORTS.app}`,
      PORT: String(PORTS.backend),
      CACHE_DIR: path.join(rootDir, ".cache", "e2e-backend"),
      ALLOW_PRIVATE_PEERS: "true",
      ALLOW_PRIVATE_UPSTREAMS: "true",
      METADATA_TIMEOUT_SECONDS: "30"
    }
  });
  const stop = () => {
    backend.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`E2E stack ready: http://localhost:${PORTS.app}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
