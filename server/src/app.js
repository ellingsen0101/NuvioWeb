import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import { ApiError, createPlaybackManager } from "./playback.js";
import { createRateLimiter, createTokenService } from "./tokens.js";
import { createTorrentEngine } from "./torrentEngine.js";
import { isToolAvailable, rewritePlaylist, supportsInputPacing } from "./media.js";
import { UpstreamError, safeGetText } from "./netGuard.js";

const MAX_BODY_BYTES = 64 * 1024;
const ADDON_PATH = /\/(manifest\.json|(catalog|meta|stream|subtitles)\/[^?#]+\.json)$/i;
const MINUTE = 60 * 1000;

const LIMITS = {
  auth: { limit: 5, windowMs: MINUTE },
  playback: { limit: 30, windowMs: MINUTE },
  proxy: { limit: 240, windowMs: MINUTE },
  api: { limit: 600, windowMs: MINUTE },
  media: { limit: 3000, windowMs: MINUTE }
};

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  response.end(text);
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new ApiError(413, "BODY_TOO_LARGE", "The request is too large.");
    chunks.push(chunk);
  }
  if (!total) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // Reported below.
  }
  throw new ApiError(400, "INVALID_JSON", "The request body isn't valid JSON.");
}

export async function createApp(config, { logger = console, createEngine = createTorrentEngine } = {}) {
  const tokens = createTokenService({
    secret: config.tokenSecret,
    accessKeys: config.accessKeys,
    sessionTtlMs: config.sessionTtlMs,
    mediaTokenTtlMs: config.mediaTokenTtlMs
  });
  const limiter = createRateLimiter();
  const [ffmpeg, ffprobe] = await Promise.all([isToolAvailable(config.ffmpegPath), isToolAvailable(config.ffprobePath)]);
  const tools = { ffmpeg, ffprobe, inputPacing: ffmpeg && (await supportsInputPacing(config.ffmpegPath)) };
  if (!ffmpeg || !ffprobe) logger.warn?.("ffmpeg or ffprobe wasn't found. Only MP4 and WebM files can be streamed.");

  let listenPort = config.port;
  const engine = config.enableTorrents ? createEngine(config, { logger }) : { sweep: async () => {}, evictIdle: async () => {}, destroy: async () => {}, release: () => {} };
  let lastPublicBase = `http://127.0.0.1:${listenPort}`;
  const playback = createPlaybackManager({
    config,
    engine,
    tokens,
    tools,
    logger,
    publicBase: () => config.publicBaseUrl || lastPublicBase,
    loopbackBase: () => `http://127.0.0.1:${listenPort}`
  });

  function clientIp(request) {
    if (config.trustProxy) {
      const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
      if (forwarded) return forwarded;
    }
    return request.socket.remoteAddress || "unknown";
  }

  function rateLimit(request, bucket) {
    const { limit, windowMs } = LIMITS[bucket];
    if (!limiter.allow(`${bucket}:${clientIp(request)}`, limit, windowMs)) {
      throw new ApiError(429, "RATE_LIMITED", "Too many requests. Wait a moment and try again.");
    }
  }

  function requireSession(request) {
    const header = String(request.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!tokens.verifySession(token)) throw new ApiError(401, "UNAUTHORIZED", "Connect to the backend again.");
  }

  function requireMediaToken(url, playbackId) {
    if (!tokens.verifyMedia(url.searchParams.get("t"), playbackId)) {
      throw new ApiError(401, "UNAUTHORIZED", "This stream link has expired.");
    }
  }

  function applyCors(request, response) {
    const origin = request.headers.origin;
    response.setHeader("Vary", "Origin");
    if (origin && config.allowedOrigins.includes(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Range");
      response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE, OPTIONS");
      response.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
      response.setHeader("Access-Control-Max-Age", "600");
    }
  }

  async function handleProxy(body) {
    const kind = body.kind === "addon" ? "addon" : "subtitle";
    const url = String(body.url || "");
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new ApiError(400, "INVALID_URL", "That isn't a valid URL.");
    }
    // Scoped on purpose: this only fetches addon protocol paths and subtitle files, so it can't be
    // used as a general-purpose web proxy for arbitrary pages.
    if (kind === "addon" && !ADDON_PATH.test(parsed.pathname)) {
      throw new ApiError(400, "NOT_ADDON_URL", "That isn't an addon URL.");
    }
    if (kind === "subtitle" && !/\.(srt|vtt|ass|ssa|sub|txt|gz)$|\/subtitles?\/|\/subs?\/|\/download\//i.test(parsed.pathname)) {
      throw new ApiError(400, "NOT_SUBTITLE_URL", "That isn't a subtitle URL.");
    }
    const buffer = await safeGetText(url, {
      maxBytes: config.proxyMaxBytes,
      timeoutMs: config.proxyTimeoutMs,
      allowPrivate: config.allowPrivateUpstreams,
      headers: { accept: kind === "addon" ? "application/json" : "*/*" }
    });
    if (kind === "addon") {
      try {
        JSON.parse(buffer.toString("utf8"));
      } catch {
        throw new ApiError(502, "NOT_JSON", "The addon didn't return valid JSON.");
      }
    }
    return { body: buffer.toString("utf8") };
  }

  async function serveHlsFile(request, response, session, generation, name, url) {
    const file = playback.hlsFilePath(session, generation, name);
    if (!file) throw new ApiError(404, "NOT_FOUND", "This segment is no longer available.");
    if (name === "index.m3u8") {
      const text = await readFile(file, "utf8").catch(() => null);
      if (text == null) throw new ApiError(404, "NOT_FOUND", "This playlist isn't ready.");
      const body = rewritePlaylist(text, url.searchParams.get("t"));
      response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" });
      response.end(body);
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new ApiError(404, "NOT_FOUND", "This segment isn't ready.");
    response.writeHead(200, {
      "Content-Type": name.endsWith(".ts") ? "video/mp2t" : "video/mp4",
      "Content-Length": info.size,
      "Cache-Control": "no-store"
    });
    const stream = createReadStream(file);
    stream.on("error", () => response.destroy());
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  }

  async function route(request, response, url) {
    const { pathname } = url;
    const method = request.method;

    if (method === "GET" && pathname === "/healthz") {
      json(response, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/v1/auth/session") {
      // Only wrong keys count, so connecting repeatedly with the right one never locks you out.
      const authBucket = `auth:${clientIp(request)}`;
      if (limiter.isExhausted(authBucket, LIMITS.auth.limit)) {
        throw new ApiError(429, "RATE_LIMITED", "Too many wrong keys. Wait a minute and try again.");
      }
      const body = await readJson(request);
      if (typeof body.accessKey !== "string" || !tokens.isValidAccessKey(body.accessKey)) {
        limiter.allow(authBucket, LIMITS.auth.limit, LIMITS.auth.windowMs);
        throw new ApiError(401, "INVALID_ACCESS_KEY", "That access key isn't valid.");
      }
      json(response, 200, tokens.issueSession());
      return;
    }

    const mediaMatch = /^\/v1\/media\/([0-9a-f-]{36})\/(file|hls\/(\d+)\/([A-Za-z0-9.]+))$/.exec(pathname);
    if (mediaMatch && (method === "GET" || method === "HEAD")) {
      rateLimit(request, "media");
      requireMediaToken(url, mediaMatch[1]);
      const session = playback.get(mediaMatch[1]);
      if (mediaMatch[2] === "file") {
        if (session.kind === "torrent" && !session.file) throw new ApiError(409, "NOT_READY", "This stream isn't ready yet.");
        await playback.serveFile(session, request, response);
      } else {
        await serveHlsFile(request, response, session, mediaMatch[3], mediaMatch[4], url);
      }
      return;
    }

    if (!pathname.startsWith("/v1/")) throw new ApiError(404, "NOT_FOUND", "Not found.");
    requireSession(request);
    rateLimit(request, "api");

    if (method === "GET" && pathname === "/v1/capabilities") {
      json(response, 200, {
        torrents: config.enableTorrents,
        remux: tools.ffmpeg && tools.ffprobe,
        transcode: config.allowTranscode && tools.ffmpeg
      });
      return;
    }
    if (method === "POST" && pathname === "/v1/proxy/fetch") {
      rateLimit(request, "proxy");
      json(response, 200, await handleProxy(await readJson(request)));
      return;
    }
    if (method === "POST" && pathname === "/v1/playback/torrent") {
      rateLimit(request, "playback");
      json(response, 201, await playback.createTorrent(await readJson(request)));
      return;
    }
    if (method === "POST" && pathname === "/v1/playback/url") {
      rateLimit(request, "playback");
      json(response, 201, await playback.createUrl(await readJson(request)));
      return;
    }
    const playbackMatch = /^\/v1\/playback\/([0-9a-f-]{36})(\/hls)?$/.exec(pathname);
    if (playbackMatch) {
      const [, id, hls] = playbackMatch;
      if (method === "GET" && !hls) {
        json(response, 200, playback.status(id));
        return;
      }
      if (method === "POST" && hls) {
        rateLimit(request, "playback");
        json(response, 200, await playback.seekHls(id, await readJson(request)));
        return;
      }
      if (method === "DELETE" && !hls) {
        await playback.release(id);
        response.writeHead(204).end();
        return;
      }
    }
    throw new ApiError(404, "NOT_FOUND", "Not found.");
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://backend.invalid");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    applyCors(request, response);

    if (config.publicBaseUrl == null) {
      const proto = config.trustProxy && request.headers["x-forwarded-proto"] === "https" ? "https" : "http";
      if (request.headers.host) lastPublicBase = `${proto}://${request.headers.host}`;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    try {
      await route(request, response, url);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : error instanceof UpstreamError ? (error.code === "BLOCKED_ADDRESS" || error.code === "INVALID_URL" ? 400 : 502) : error.status || 500;
      const known = error instanceof ApiError || error instanceof UpstreamError || error.status;
      if (!known) logger.error?.(`Unhandled error on ${request.method} ${url.pathname}: ${error.message}`);
      if (response.headersSent) {
        response.destroy();
      } else {
        json(response, status, { code: error.code || "INTERNAL_ERROR", message: known ? error.message : "Something went wrong on the backend." });
      }
    }
  });
  // Long-lived media responses must not be cut off by the default request timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 30000;

  const sweepTimer = setInterval(() => {
    playback.sweep().catch((error) => logger.warn?.(`Sweep failed: ${error.message}`));
  }, config.sweepIntervalMs);
  sweepTimer.unref();

  return {
    server,
    playback,
    tokens,
    engine,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          listenPort = server.address().port;
          lastPublicBase = `http://127.0.0.1:${listenPort}`;
          resolve(listenPort);
        });
      });
    },
    async close() {
      clearInterval(sweepTimer);
      await playback.destroy();
      await engine.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
