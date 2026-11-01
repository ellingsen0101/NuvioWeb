// End-to-end tests against a real server. Test media is generated locally with ffmpeg and shared by
// a local WebTorrent seeder, so nothing here depends on the internet or on third-party content.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import WebTorrent from "webtorrent";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const ACCESS_KEY = "test-access-key-".padEnd(32, "x");
const ORIGIN = "https://nuvio.test";
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const silent = { info() {}, warn() {}, error() {} };
const workDir = mkdtempSync(path.join(os.tmpdir(), "nuvio-backend-test-"));

function makeVideo(name, extraArgs) {
  const output = path.join(workDir, name);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=20",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=20",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p",
    ...extraArgs,
    output
  ]);
  return output;
}

async function startApp(overrides = {}) {
  const config = loadConfig({
    ACCESS_KEYS: ACCESS_KEY,
    TOKEN_SECRET: "t".repeat(48),
    ALLOWED_ORIGINS: ORIGIN,
    PORT: "0",
    CACHE_DIR: path.join(workDir, `cache-${Math.random().toString(36).slice(2)}`),
    METADATA_TIMEOUT_SECONDS: "30",
    ALLOW_PRIVATE_PEERS: "true",
    ...overrides
  });
  config.publicBaseUrl = null;
  const app = await createApp(config, { logger: silent });
  const port = await app.listen();
  return { app, base: `http://127.0.0.1:${port}` };
}

async function api(base, pathname, { method = "GET", body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers };
}

async function login(base) {
  const { data } = await api(base, "/v1/auth/session", { method: "POST", body: { accessKey: ACCESS_KEY } });
  return data.token;
}

async function waitReady(base, token, id, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await api(base, `/v1/playback/${id}`, { token });
    if (data.state === "ready" || data.state === "error") return data;
    if (Date.now() > deadline) throw new Error(`Timed out in state ${data.state}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe("authentication and access control", () => {
  let ctx;
  before(async () => {
    ctx = await startApp({ ENABLE_TORRENTS: "false" });
  });
  after(() => ctx.app.close());

  test("health check reveals nothing", async () => {
    const { status, data } = await api(ctx.base, "/healthz");
    assert.equal(status, 200);
    assert.deepEqual(data, { ok: true });
  });

  test("every API route rejects missing and invalid tokens", async () => {
    const routes = [
      ["GET", "/v1/capabilities"],
      ["POST", "/v1/proxy/fetch"],
      ["POST", "/v1/playback/torrent"],
      ["POST", "/v1/playback/url"],
      ["GET", "/v1/playback/00000000-0000-0000-0000-000000000000"],
      ["DELETE", "/v1/playback/00000000-0000-0000-0000-000000000000"]
    ];
    for (const [method, route] of routes) {
      for (const token of [undefined, "garbage", "a.b"]) {
        const { status } = await api(ctx.base, route, { method, token, body: method === "POST" ? {} : undefined });
        assert.equal(status, 401, `${method} ${route} with ${token}`);
      }
    }
  });

  test("a wrong access key is refused and a right one gets a session", async () => {
    const wrong = await api(ctx.base, "/v1/auth/session", { method: "POST", body: { accessKey: "nope" } });
    assert.equal(wrong.status, 401);
    const token = await login(ctx.base);
    const { status, data } = await api(ctx.base, "/v1/capabilities", { token });
    assert.equal(status, 200);
    assert.equal(data.torrents, false);
  });

  test("login attempts are rate limited", async () => {
    const statuses = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      statuses.push((await api(ctx.base, "/v1/auth/session", { method: "POST", body: { accessKey: "wrong" } })).status);
    }
    assert.ok(statuses.includes(429), statuses.join());
  });

  test("CORS allows only the configured origin", async () => {
    const allowed = await api(ctx.base, "/healthz", { headers: { Origin: ORIGIN } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), ORIGIN);
    const other = await api(ctx.base, "/healthz", { headers: { Origin: "https://evil.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  });

  test("errors don't leak internals and bodies are limited", async () => {
    const big = await fetch(`${ctx.base}/v1/auth/session`, { method: "POST", body: "x".repeat(70 * 1024) }).catch(() => null);
    assert.ok(!big || big.status === 413 || big.status === 429);
    const notFound = await api(ctx.base, "/etc/passwd");
    assert.equal(notFound.status, 404);
  });
});

describe("SSRF protection", () => {
  let ctx;
  let token;
  let internal;
  let internalHits = 0;
  let internalPort;
  before(async () => {
    ctx = await startApp({ ENABLE_TORRENTS: "false" });
    token = await login(ctx.base);
    internal = http.createServer((request, response) => {
      internalHits += 1;
      response.end(JSON.stringify({ secret: true }));
    });
    await new Promise((resolve) => internal.listen(0, "127.0.0.1", resolve));
    internalPort = internal.address().port;
  });
  after(async () => {
    internal.close();
    await ctx.app.close();
  });

  const blockedTargets = (port) => [
    `http://127.0.0.1:${port}/manifest.json`,
    `http://localhost:${port}/manifest.json`,
    `http://[::1]:${port}/manifest.json`,
    `http://169.254.169.254/manifest.json`,
    `http://10.0.0.1/manifest.json`,
    `http://192.168.0.1/manifest.json`,
    `http://2130706433:${port}/manifest.json`,
    `file:///etc/manifest.json`
  ];

  test("the proxy refuses internal targets without contacting them", async () => {
    for (const url of blockedTargets(internalPort)) {
      const { status, data } = await api(ctx.base, "/v1/proxy/fetch", { method: "POST", token, body: { url, kind: "addon" } });
      assert.equal(status, 400, url);
      assert.ok(!JSON.stringify(data).includes("secret"));
    }
    assert.equal(internalHits, 0);
  });

  test("the proxy only serves addon and subtitle paths", async () => {
    for (const [url, kind] of [
      ["https://example.com/", "addon"],
      ["https://example.com/admin/config.json", "addon"],
      ["https://example.com/index.html", "subtitle"]
    ]) {
      const { status } = await api(ctx.base, "/v1/proxy/fetch", { method: "POST", token, body: { url, kind } });
      assert.equal(status, 400, url);
    }
  });

  test("URL playback refuses internal targets", async () => {
    for (const url of blockedTargets(internalPort)) {
      const { status } = await api(ctx.base, "/v1/playback/url", { method: "POST", token, body: { url } });
      assert.equal(status, 400, url);
    }
    assert.equal(internalHits, 0);
  });

  test("a hostname that resolves to an internal address is refused at connect time", async () => {
    // nip.io style name, when reachable. A DNS failure is also a refusal, which keeps this offline-safe.
    const { status } = await api(ctx.base, "/v1/proxy/fetch", {
      method: "POST",
      token,
      body: { url: `http://127.0.0.1.nip.io:${internalPort}/manifest.json`, kind: "addon" }
    });
    assert.ok(status >= 400 && status < 600);
    assert.equal(internalHits, 0);
  });
});

describe("URL playback and remuxing", { skip: !hasFfmpeg && "ffmpeg isn't installed" }, () => {
  let ctx;
  let token;
  let origin;
  let mp4;
  let mkv;
  let originPort;
  before(async () => {
    mp4 = makeVideo("direct.mp4", ["-c:a", "aac", "-movflags", "+faststart"]);
    mkv = makeVideo("remux.mkv", ["-c:a", "ac3"]);
    const files = { "/video/direct.mp4": readFileSync(mp4), "/video/remux.mkv": readFileSync(mkv) };
    origin = http.createServer((request, response) => {
      const file = files[request.url];
      if (!file) {
        response.writeHead(404).end();
        return;
      }
      const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range || "");
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : file.length - 1;
        response.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${file.length}`, "Content-Length": end - start + 1, "Accept-Ranges": "bytes" });
        response.end(file.subarray(start, end + 1));
      } else {
        response.writeHead(200, { "Content-Length": file.length, "Accept-Ranges": "bytes" });
        response.end(file);
      }
    });
    await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
    originPort = origin.address().port;
    ctx = await startApp({ ENABLE_TORRENTS: "false", ALLOW_PRIVATE_UPSTREAMS: "true" });
    token = await login(ctx.base);
  });
  after(async () => {
    origin?.close();
    await ctx?.app.close();
  });

  test("a compatible MP4 plays directly with working Range requests", async () => {
    const { data: created } = await api(ctx.base, "/v1/playback/url", { method: "POST", token, body: { url: `http://127.0.0.1:${originPort}/video/direct.mp4`, capabilities: {} } });
    const ready = await waitReady(ctx.base, token, created.id);
    assert.equal(ready.state, "ready", ready.message);
    assert.equal(ready.mode, "direct");
    assert.ok(Math.abs(ready.duration - 20) < 1);
    const partial = await fetch(ready.url, { headers: { Range: "bytes=100-199" } });
    assert.equal(partial.status, 206);
    assert.equal((await partial.arrayBuffer()).byteLength, 100);
    await api(ctx.base, `/v1/playback/${created.id}`, { method: "DELETE", token });
  });

  test("MKV with AC3 is remuxed to HLS, and a seek restarts it at the new position", async () => {
    const { data: created } = await api(ctx.base, "/v1/playback/url", { method: "POST", token, body: { url: `http://127.0.0.1:${originPort}/video/remux.mkv`, capabilities: {} } });
    const ready = await waitReady(ctx.base, token, created.id);
    assert.equal(ready.state, "ready", ready.message);
    assert.equal(ready.mode, "hls");
    assert.equal(ready.audioTracks[0].detail.startsWith("AC3"), true);

    const playlist = await (await fetch(ready.url)).text();
    assert.match(playlist, /#EXTM3U/);
    const segment = playlist.split("\n").find((line) => line && !line.startsWith("#"));
    assert.match(segment, /seg\d+\.ts\?t=/);
    const segmentResponse = await fetch(new URL(segment, ready.url));
    assert.equal(segmentResponse.status, 200);
    assert.ok((await segmentResponse.arrayBuffer()).byteLength > 100);

    const seek = await api(ctx.base, `/v1/playback/${created.id}/hls`, { method: "POST", token, body: { start: 12 } });
    assert.equal(seek.status, 200, JSON.stringify(seek.data));
    assert.equal(seek.data.startOffset, 12);
    assert.match(await (await fetch(seek.data.url)).text(), /#EXTM3U/);
    await api(ctx.base, `/v1/playback/${created.id}`, { method: "DELETE", token });
  });

  test("media URLs need their own token, and it stops working when the session ends", async () => {
    const { data: created } = await api(ctx.base, "/v1/playback/url", { method: "POST", token, body: { url: `http://127.0.0.1:${originPort}/video/direct.mp4` } });
    const ready = await waitReady(ctx.base, token, created.id);
    const noToken = await fetch(ready.url.split("?")[0]);
    assert.equal(noToken.status, 401);
    const { data: other } = await api(ctx.base, "/v1/playback/url", { method: "POST", token, body: { url: `http://127.0.0.1:${originPort}/video/direct.mp4` } });
    await waitReady(ctx.base, token, other.id);
    const wrongSession = await fetch(ready.url.replace(created.id, other.id));
    assert.equal(wrongSession.status, 401, "a token for one session can't read another");
    await api(ctx.base, `/v1/playback/${created.id}`, { method: "DELETE", token });
    assert.equal((await fetch(ready.url)).status, 404);
    await api(ctx.base, `/v1/playback/${other.id}`, { method: "DELETE", token });
  });

  test("the session limit is enforced", async () => {
    const limited = await startApp({ ENABLE_TORRENTS: "false", ALLOW_PRIVATE_UPSTREAMS: "true", MAX_SESSIONS: "1" });
    const limitedToken = await login(limited.base);
    const body = { url: `http://127.0.0.1:${originPort}/video/direct.mp4` };
    const first = await api(limited.base, "/v1/playback/url", { method: "POST", token: limitedToken, body });
    assert.equal(first.status, 201);
    const second = await api(limited.base, "/v1/playback/url", { method: "POST", token: limitedToken, body });
    assert.equal(second.status, 429);

    // A session nobody has touched for a while makes way for a new one.
    limited.app.playback.get(first.data.id).lastActivityAt = Date.now() - 60000;
    const third = await api(limited.base, "/v1/playback/url", { method: "POST", token: limitedToken, body });
    assert.equal(third.status, 201);
    assert.equal((await api(limited.base, `/v1/playback/${first.data.id}`, { token: limitedToken })).status, 404);
    await limited.app.close();
  });
});

describe("torrent streaming", { skip: !hasFfmpeg && "ffmpeg isn't installed" }, () => {
  let ctx;
  let token;
  let seeder;
  let infoHash;
  let sourceBytes;
  let seederPort;
  before(async () => {
    const video = makeVideo("torrent-video.mp4", ["-c:a", "aac", "-movflags", "+faststart"]);
    sourceBytes = readFileSync(video);
    seeder = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false, webSeeds: false, natUpnp: false, natPmp: false });
    const torrent = await new Promise((resolve) => {
      seeder.seed(video, { announce: [] }, resolve);
    });
    infoHash = torrent.infoHash;
    seederPort = seeder.address().port;

    ctx = await startApp({ TORRENT_MAX_CONNECTIONS: "10", TORRENT_LINGER_MINUTES: "0", ALLOW_PRIVATE_PEERS: "true" });
    token = await login(ctx.base);
  });
  after(async () => {
    await ctx?.app.close();
    await new Promise((resolve) => (seeder ? seeder.destroy(resolve) : resolve()));
  });

  test("invalid hashes are refused", async () => {
    for (const value of ["", "xyz", "a".repeat(39), `${"a".repeat(40)}&dn=x`]) {
      const { status } = await api(ctx.base, "/v1/playback/torrent", { method: "POST", token, body: { infoHash: value } });
      assert.equal(status, 400, value);
    }
  });

  test("a seeded torrent streams with correct bytes, at any offset, then gets cleaned up", async () => {
    // The local seeder isn't on any tracker, so it's introduced to the backend's torrent directly.
    const { data: created } = await api(ctx.base, "/v1/playback/torrent", { method: "POST", token, body: { infoHash, capabilities: {}, sources: [] } });
    const connect = setInterval(() => ctx.app.engine.addPeer(infoHash, `127.0.0.1:${seederPort}`), 500);
    try {
      const ready = await waitReady(ctx.base, token, created.id, 60000);
      assert.equal(ready.state, "ready", ready.message);
      assert.equal(ready.mode, "direct");
      assert.equal(ready.files.length, 1);
      assert.ok(ready.duration > 19);

      const whole = Buffer.from(await (await fetch(ready.url)).arrayBuffer());
      assert.equal(createHash("sha1").update(whole).digest("hex"), createHash("sha1").update(sourceBytes).digest("hex"));

      const start = Math.floor(sourceBytes.length / 2);
      const partial = await fetch(ready.url, { headers: { Range: `bytes=${start}-${start + 999}` } });
      assert.equal(partial.status, 206);
      assert.equal(partial.headers.get("content-range"), `bytes ${start}-${start + 999}/${sourceBytes.length}`);
      assert.ok(Buffer.from(await partial.arrayBuffer()).equals(sourceBytes.subarray(start, start + 1000)));

      const beyond = await fetch(ready.url, { headers: { Range: `bytes=${sourceBytes.length + 5}-` } });
      assert.equal(beyond.status, 416);
    } finally {
      clearInterval(connect);
    }
    await api(ctx.base, `/v1/playback/${created.id}`, { method: "DELETE", token });
    assert.equal(ctx.app.playback.size, 0);
    await ctx.app.playback.sweep(Date.now() + 1000);
  });

  test("a torrent with no peers ends in a clear error, not a hang", async () => {
    const quiet = await startApp({ METADATA_TIMEOUT_SECONDS: "2" });
    const quietToken = await login(quiet.base);
    const { data } = await api(quiet.base, "/v1/playback/torrent", { method: "POST", token: quietToken, body: { infoHash: "f".repeat(40) } });
    const final = await waitReady(quiet.base, quietToken, data.id, 15000);
    assert.equal(final.state, "error");
    assert.equal(final.code, "METADATA_TIMEOUT");
    await quiet.app.close();
  });
});

after(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
});
