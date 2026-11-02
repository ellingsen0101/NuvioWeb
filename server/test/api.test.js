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
import { generateCode, hashCode, writeInvites } from "../src/invites.js";

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

const hasX265 = hasFfmpeg && execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).includes("libx265");

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
    INVITES_FILE: path.join(workDir, "no-invites.json"),
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
  const invitesFile = path.join(workDir, "invites.json");
  before(async () => {
    ctx = await startApp({ ENABLE_TORRENTS: "false", INVITES_FILE: invitesFile });
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

  test("a friend's invite code signs in, and revoking it ends the session at once", async () => {
    const code = generateCode();
    writeInvites(invitesFile, [{ name: "Friend", hash: hashCode(code), createdAt: "2026-11-02" }]);
    const login = await api(ctx.base, "/v1/auth/session", { method: "POST", body: { accessKey: code } });
    assert.equal(login.status, 200);
    assert.equal(login.data.name, "Friend");
    assert.equal((await api(ctx.base, "/v1/capabilities", { token: login.data.token })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeInvites(invitesFile, []);
    assert.equal((await api(ctx.base, "/v1/capabilities", { token: login.data.token })).status, 401);
  });

  test("someone asks for access, the owner approves, and they're in without a code", async () => {
    writeInvites(invitesFile, [{ name: "Owner Phone", hash: hashCode("owner-phone-code"), admin: true, createdAt: "2026-11-02" }]);
    const owner = (await api(ctx.base, "/v1/auth/session", { method: "POST", body: { accessKey: "owner-phone-code" } })).data.token;
    assert.deepEqual((await api(ctx.base, "/v1/me", { token: owner })).data, { name: "Owner Phone", admin: true });

    const asked = await api(ctx.base, "/v1/access/requests", { method: "POST", body: { name: "  Vilde <b> ", signInCode: "AB12CD", signInLink: "https://nuvio.tv/link?code=AB12CD" } });
    assert.equal(asked.status, 201);
    const check = () => api(ctx.base, `/v1/access/requests/${asked.data.id}`, { headers: { "X-Request-Token": asked.data.pollToken } });
    assert.equal((await check()).data.status, "pending");
    assert.equal((await api(ctx.base, `/v1/access/requests/${asked.data.id}`, { headers: { "X-Request-Token": "guess" } })).status, 404, "needs the request's own secret");

    const pending = (await api(ctx.base, "/v1/admin/requests", { token: owner })).data.requests;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].name, "Vilde b", "markup stripped");
    assert.equal(pending[0].signInLink, "https://nuvio.tv/link?code=AB12CD");

    const approved = await api(ctx.base, `/v1/admin/requests/${asked.data.id}/approve`, { method: "POST", token: owner });
    assert.equal(approved.status, 200);
    const first = (await check()).data;
    assert.equal(first.status, "approved");
    assert.match(first.code, /^[a-z2-9-]{27}$/);
    assert.equal((await check()).data.code, undefined, "the code is handed over once");

    const friend = (await api(ctx.base, "/v1/auth/session", { method: "POST", body: { accessKey: first.code } })).data.token;
    assert.deepEqual((await api(ctx.base, "/v1/me", { token: friend })).data, { name: "Vilde b", admin: false });
    assert.equal((await api(ctx.base, "/v1/admin/requests", { token: friend })).status, 403, "friends can't approve");

    const people = (await api(ctx.base, "/v1/admin/people", { token: owner })).data.people.map((person) => person.name);
    assert.deepEqual(people, ["Owner Phone", "Vilde b"]);
    assert.equal((await api(ctx.base, `/v1/admin/people/${encodeURIComponent("Owner Phone")}`, { method: "DELETE", token: owner })).status, 409, "the owner can't remove themselves");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await api(ctx.base, `/v1/admin/people/${encodeURIComponent("Vilde b")}`, { method: "DELETE", token: owner })).status, 204);
    assert.equal((await api(ctx.base, "/v1/me", { token: friend })).status, 401, "removed at once");
    writeInvites(invitesFile, []);
  });

  test("requests can't carry links to other sites, and are rate limited", async () => {
    const phishing = await api(ctx.base, "/v1/access/requests", { method: "POST", body: { name: "Mallory", signInLink: "https://nuvio.tv.evil.example/link" } });
    assert.equal(phishing.status, 400);
    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await api(ctx.base, "/v1/access/requests", { method: "POST", body: { name: `Spam ${attempt}` } })).status);
    }
    assert.ok(statuses.includes(429), statuses.join());
  });

  test("logging in repeatedly with the right key isn't rate limited", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { status } = await api(ctx.base, "/v1/auth/session", { method: "POST", body: { accessKey: ACCESS_KEY } });
      assert.equal(status, 200, `attempt ${attempt}`);
    }
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
  let redirectHits = 0;
  before(async () => {
    mp4 = makeVideo("direct.mp4", ["-c:a", "aac", "-movflags", "+faststart"]);
    mkv = makeVideo("remux.mkv", ["-c:a", "ac3"]);
    const longGop = makeVideo("longgop.mkv", ["-c:a", "aac", "-g", "240", "-keyint_min", "240", "-sc_threshold", "0"]);
    const files = { "/video/direct.mp4": readFileSync(mp4), "/video/remux.mkv": readFileSync(mkv), "/video/longgop.mkv": readFileSync(longGop) };
    if (hasX265) {
      const hevc = path.join(workDir, "hevc.mkv");
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=12", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error:keyint=48", "-pix_fmt", "yuv420p10le", "-c:a", "ac3", hevc]);
      files["/video/hevc.mkv"] = readFileSync(hevc);
    }
    origin = http.createServer((request, response) => {
      if (request.url.startsWith("/redirect/")) {
        redirectHits += 1;
        response.writeHead(302, { Location: request.url.replace("/redirect/", "/video/") }).end();
        return;
      }
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
    assert.equal(ready.sourceUrl, `http://127.0.0.1:${originPort}/video/direct.mp4`);
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

  test("a seek reports where the copied video really starts, not the time asked for", async () => {
    const { data: created } = await api(ctx.base, "/v1/playback/url", { method: "POST", token, body: { url: `http://127.0.0.1:${originPort}/video/longgop.mkv`, capabilities: {} } });
    const ready = await waitReady(ctx.base, token, created.id);
    assert.equal(ready.state, "ready", ready.message);
    assert.ok(ready.startOffset < 0.5, `start ${ready.startOffset}`);
    // Keyframes are every 10 seconds, so a seek to 12 has to begin at 10.
    const seek = await api(ctx.base, `/v1/playback/${created.id}/hls`, { method: "POST", token, body: { start: 12 } });
    assert.equal(seek.status, 200, JSON.stringify(seek.data));
    assert.ok(Math.abs(seek.data.startOffset - 10) < 0.3, `offset was ${seek.data.startOffset}`);
    await api(ctx.base, `/v1/playback/${created.id}`, { method: "DELETE", token });
  });

  test("10-bit HEVC is remuxed to fMP4 with a reachable init segment", { skip: !hasX265 && "this ffmpeg has no libx265" }, async () => {
    const { data: created } = await api(ctx.base, "/v1/playback/url", { method: "POST", token, body: { url: `http://127.0.0.1:${originPort}/video/hevc.mkv`, capabilities: { hevc: true } } });
    const ready = await waitReady(ctx.base, token, created.id);
    assert.equal(ready.state, "ready", ready.message);
    assert.equal(ready.mode, "hls");
    assert.equal(ready.info.videoCodec, "hevc");
    const playlist = await (await fetch(ready.url)).text();
    const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)?.[1];
    assert.ok(init, "playlist names an init segment");
    const initResponse = await fetch(new URL(init, ready.url));
    assert.equal(initResponse.status, 200);
    const initBytes = Buffer.from(await initResponse.arrayBuffer());
    const hvcc = initBytes.indexOf("hvcC");
    assert.ok(hvcc > 0, "init has an hvcC box");
    assert.ok(initBytes.readUInt32BE(hvcc - 4) > 40, "hvcC holds parameter sets, not just a header");
    assert.ok(initBytes.includes("hvc1"));
    const segment = playlist.split("\n").find((line) => line && !line.startsWith("#"));
    assert.match(segment, /seg\d+\.m4s\?t=/);
    assert.equal((await fetch(new URL(segment, ready.url))).status, 200);
    await api(ctx.base, `/v1/playback/${created.id}`, { method: "DELETE", token });
  });

  test("a redirecting source is only resolved once", async () => {
    const before = redirectHits;
    const { data: created } = await api(ctx.base, "/v1/playback/url", { method: "POST", token, body: { url: `http://127.0.0.1:${originPort}/redirect/remux.mkv`, capabilities: {} } });
    const ready = await waitReady(ctx.base, token, created.id);
    assert.equal(ready.state, "ready", ready.message);
    assert.equal(redirectHits - before, 1);
    await api(ctx.base, `/v1/playback/${created.id}`, { method: "DELETE", token });
  });

  test("a source that fails says so", async () => {
    const { data: created } = await api(ctx.base, "/v1/playback/url", { method: "POST", token, body: { url: `http://127.0.0.1:${originPort}/video/missing.mkv`, capabilities: {} } });
    const final = await waitReady(ctx.base, token, created.id);
    assert.equal(final.state, "error");
    assert.match(final.message, /answered 404/);
  });

  test("a retry can force a remux", async () => {
    const { data: created } = await api(ctx.base, "/v1/playback/url", { method: "POST", token, body: { url: `http://127.0.0.1:${originPort}/video/direct.mp4`, capabilities: {}, forceRemux: true } });
    const ready = await waitReady(ctx.base, token, created.id);
    assert.equal(ready.mode, "hls", ready.message);
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
