import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { buildHlsArgs, decidePlayback, rewritePlaylist, selectFileIndex, summarizeProbe } from "../src/media.js";
import { isBlockedAddress, parsePublicUrl, sanitizeUpstreamHeaders } from "../src/netGuard.js";
import { createRateLimiter, createTokenService } from "../src/tokens.js";
import { trackersFromSources } from "../src/torrentEngine.js";

const SECRET = "x".repeat(40);

function tokenService(overrides = {}) {
  return createTokenService({ secret: SECRET, accessKeys: ["k".repeat(30)], sessionTtlMs: 1000, mediaTokenTtlMs: 1000, ...overrides });
}

test("config refuses to start without secrets or with a wildcard origin", () => {
  assert.throws(() => loadConfig({}), /ACCESS_KEYS is required/);
  assert.throws(() => loadConfig({ ACCESS_KEYS: "short", TOKEN_SECRET: SECRET }), /at least 24/);
  assert.throws(() => loadConfig({ ACCESS_KEYS: "k".repeat(30), TOKEN_SECRET: "short" }), /TOKEN_SECRET/);
  assert.throws(() => loadConfig({ ACCESS_KEYS: "k".repeat(30), TOKEN_SECRET: SECRET, ALLOWED_ORIGINS: "*" }), /exact origins/);
  const config = loadConfig({ ACCESS_KEYS: "k".repeat(30), TOKEN_SECRET: SECRET });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.allowTranscode, false);
  assert.equal(config.allowPrivatePeers, false);
});

test("session tokens verify, expire and resist tampering", () => {
  let time = 1000;
  const service = tokenService({ now: () => time });
  const { token } = service.issueSession();
  assert.ok(service.verifySession(token));
  assert.equal(service.verifySession(`${token}x`), null);
  assert.equal(service.verifySession(`a${token}`), null);
  assert.equal(service.verifySession(""), null);
  time += 2000;
  assert.equal(service.verifySession(token), null);
});

test("media tokens are scoped to one playback and can't act as sessions", () => {
  const service = tokenService();
  const token = service.issueMedia("playback-a");
  assert.equal(service.verifyMedia(token, "playback-a"), true);
  assert.equal(service.verifyMedia(token, "playback-b"), false);
  assert.equal(service.verifySession(token), null);
  assert.equal(service.verifyMedia(service.issueSession().token, "playback-a"), false);
});

test("a token signed with another secret is rejected", () => {
  const other = tokenService({ secret: "y".repeat(40) });
  assert.equal(tokenService().verifySession(other.issueSession().token), null);
});

test("access key comparison accepts only configured keys", () => {
  const service = tokenService();
  assert.equal(service.isValidAccessKey("k".repeat(30)), true);
  assert.equal(service.isValidAccessKey("k".repeat(29)), false);
  assert.equal(service.isValidAccessKey(""), false);
});

test("rate limiter blocks past the limit and resets", () => {
  let time = 0;
  const limiter = createRateLimiter({ now: () => time });
  assert.equal(limiter.allow("a", 2, 100), true);
  assert.equal(limiter.allow("a", 2, 100), true);
  assert.equal(limiter.allow("a", 2, 100), false);
  assert.equal(limiter.allow("b", 2, 100), true);
  time = 200;
  assert.equal(limiter.allow("a", 2, 100), true);
});

test("internal addresses are blocked, including mapped IPv6", () => {
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
  assert.equal(isBlockedAddress("not-an-ip"), true);
});

test("URL validation rejects internal hosts, other schemes and credentials", () => {
  for (const url of [
    "http://127.0.0.1/", "http://[::1]/", "http://localhost/", "http://foo.localhost/", "http://printer.local/",
    "http://metadata.internal/", "http://169.254.169.254/latest/meta-data/", "http://2130706433/", "http://0x7f.0.0.1/",
    "file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "http://user:pass@example.com/", "not a url"
  ]) {
    assert.throws(() => parsePublicUrl(url), undefined, url);
  }
  assert.equal(parsePublicUrl("https://example.com/manifest.json").hostname, "example.com");
});

test("upstream headers drop hop-by-hop values and header injection", () => {
  assert.deepEqual(
    sanitizeUpstreamHeaders({ Host: "evil", Referer: "https://a", "X-Forwarded-For": "1.1.1.1", "x-bad": "a\r\nb: c", "user-agent": "x", num: 1 }),
    { referer: "https://a", "user-agent": "x" }
  );
  assert.deepEqual(sanitizeUpstreamHeaders(null), {});
});

test("addon trackers can't point at internal hosts", () => {
  const trackers = trackersFromSources([
    "tracker:udp://tracker.example.org:1337/announce",
    "tracker:http://127.0.0.1:8080/announce",
    "tracker:http://169.254.169.254/announce",
    "tracker:file:///etc/passwd",
    "dht:abcdef",
    42
  ]);
  assert.deepEqual(trackers, ["udp://tracker.example.org:1337/announce"]);
});

test("file selection honours index, filename and episode, then size", () => {
  const files = [
    { name: "Show/sample.mkv", length: 10 },
    { name: "Show/Show.S01E01.mkv", length: 100 },
    { name: "Show/Show.S01E02.mkv", length: 90 },
    { name: "Show/Show.S01E12.mkv", length: 95 },
    { name: "Show/notes.txt", length: 5000 }
  ];
  assert.equal(selectFileIndex(files, { fileIdx: 2 }), 2);
  assert.equal(selectFileIndex(files, { filename: "show.s01e12.mkv" }), 3);
  assert.equal(selectFileIndex(files, { season: 1, episode: 2 }), 2);
  assert.equal(selectFileIndex(files, { season: 1, episode: 1 }), 1);
  assert.equal(selectFileIndex(files, {}), 1, "largest video, not the larger text file");
  assert.equal(selectFileIndex(files, { fileIdx: 99 }), 1, "bad index falls back");
  assert.equal(selectFileIndex([{ name: "a.txt", length: 1 }], {}), -1);
});

function summary(overrides = {}) {
  return { container: "mov,mp4,m4a,3gp,3g2,mj2", videoCodec: "h264", pixFmt: "yuv420p", audioTracks: [{ index: 1, codec: "aac" }], ...overrides };
}

test("playback mode follows the container, codecs and device", () => {
  assert.equal(decidePlayback(summary(), {}).mode, "direct");
  assert.deepEqual(decidePlayback(summary({ container: "matroska,webm" }), {}), { mode: "hls", video: "copy", segmentType: "mpegts" });
  assert.equal(decidePlayback(summary({ audioTracks: [{ codec: "dts" }] }), {}).mode, "hls", "unplayable audio");
  assert.equal(decidePlayback(summary({ audioTracks: [{ codec: "ac3" }] }), { ac3: true }).mode, "direct");
  assert.deepEqual(decidePlayback(summary({ container: "matroska,webm", videoCodec: "hevc" }), { hevc: true }), { mode: "hls", video: "copy", segmentType: "fmp4" });
  assert.equal(decidePlayback(summary({ videoCodec: "hevc" }), { hevc: true }).mode, "direct");
  assert.equal(decidePlayback(summary({ pixFmt: "yuv420p10le" }), {}, { allowTranscode: true }).video, "transcode");
});

test("a codec the device can't decode is refused unless transcoding is on", () => {
  const hevc = summary({ container: "matroska,webm", videoCodec: "hevc" });
  const refused = decidePlayback(hevc, { hevc: false });
  assert.equal(refused.mode, "unsupported");
  assert.equal(refused.code, "TRANSCODE_DISABLED");
  assert.equal(decidePlayback(hevc, { hevc: false }, { allowTranscode: true }).video, "transcode");
  assert.equal(decidePlayback(summary({ container: "matroska,webm" }), {}, { canRemux: false }).code, "REMUX_UNAVAILABLE");
  assert.equal(decidePlayback(summary({ videoCodec: "" }), {}).code, "NO_VIDEO");
});

test("probe summary ignores cover art and lists tracks", () => {
  const result = summarizeProbe({
    format: { format_name: "matroska,webm", duration: "120.5" },
    streams: [
      { index: 0, codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
      { index: 1, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" },
      { index: 2, codec_type: "audio", codec_name: "aac", channels: 2, tags: { language: "eng", title: "Main" } },
      { index: 3, codec_type: "subtitle", codec_name: "subrip", tags: { language: "nor" } }
    ]
  });
  assert.equal(result.videoCodec, "h264");
  assert.equal(result.duration, 120.5);
  assert.equal(result.audioTracks[0].label, "Main");
  assert.equal(result.audioTracks[0].detail, "AAC 2ch");
  assert.equal(result.subtitleTracks[0].language, "nor");
});

test("ffmpeg arguments restrict input protocols and select the audio stream", () => {
  const args = buildHlsArgs({
    inputUrl: "http://127.0.0.1:1/file",
    outputDir: "out",
    start: 30,
    audioIndex: 3,
    audioCodec: "dts",
    decision: { video: "copy", segmentType: "mpegts" }
  });
  assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "http,tcp");
  assert.equal(args[args.indexOf("-ss") + 1], "30");
  assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "fast seek happens before the input");
  assert.ok(args.includes("0:3"));
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
});

test("playlists get the media token on every URI and lose directory paths", () => {
  const output = rewritePlaylist('#EXTM3U\n#EXT-X-MAP:URI="/tmp/x/init.mp4"\n#EXTINF:4,\n/tmp/x/seg00000.m4s\n#EXT-X-ENDLIST\n', "a+b");
  assert.ok(output.includes('URI="init.mp4?t=a%2Bb"'));
  assert.ok(output.includes("\nseg00000.m4s?t=a%2Bb\n"));
  assert.ok(!output.includes("/tmp"));
  assert.ok(output.startsWith("#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n"), "plays from the start while still being written");
});
