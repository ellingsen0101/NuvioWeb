import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function integer(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && env[name] !== "" && env[name] != null ? Math.trunc(value) : fallback;
}

function flag(env, name, fallback) {
  const value = env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function list(env, name) {
  return String(env[name] || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const MIN_SECRET_LENGTH = 24;

// The service refuses to start without real secrets: there is no unauthenticated mode.
export function loadConfig(env = process.env) {
  const accessKeys = list(env, "ACCESS_KEYS");
  const tokenSecret = String(env.TOKEN_SECRET || "");
  const problems = [];
  if (!accessKeys.length) problems.push("ACCESS_KEYS is required");
  if (accessKeys.some((key) => key.length < MIN_SECRET_LENGTH)) {
    problems.push(`each ACCESS_KEYS entry needs at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (tokenSecret.length < 32) problems.push("TOKEN_SECRET needs at least 32 characters");
  const allowedOrigins = list(env, "ALLOWED_ORIGINS");
  if (allowedOrigins.includes("*")) problems.push("ALLOWED_ORIGINS must list exact origins, not *");
  if (problems.length) throw new Error(`Invalid configuration: ${problems.join("; ")}`);

  return {
    host: env.HOST || "127.0.0.1",
    port: integer(env, "PORT", 8787),
    trustProxy: flag(env, "TRUST_PROXY", false),
    accessKeys,
    tokenSecret,
    allowedOrigins,
    sessionTtlMs: integer(env, "SESSION_TTL_HOURS", 24 * 30) * 3600 * 1000,
    mediaTokenTtlMs: integer(env, "MEDIA_TOKEN_TTL_HOURS", 12) * 3600 * 1000,

    enableTorrents: flag(env, "ENABLE_TORRENTS", true),
    allowTranscode: flag(env, "ALLOW_TRANSCODE", false),
    allowPrivatePeers: flag(env, "ALLOW_PRIVATE_PEERS", false),
    allowPrivateUpstreams: flag(env, "ALLOW_PRIVATE_UPSTREAMS", false),
    cacheDir: env.CACHE_DIR || path.join(os.tmpdir(), "nuvio-web-backend"),
    ffmpegPath: env.FFMPEG_PATH || "ffmpeg",
    ffprobePath: env.FFPROBE_PATH || "ffprobe",

    maxSessions: integer(env, "MAX_SESSIONS", 4),
    maxTorrents: integer(env, "MAX_TORRENTS", 3),
    maxFfmpegProcesses: integer(env, "MAX_FFMPEG_PROCESSES", 2),
    maxConnections: integer(env, "TORRENT_MAX_CONNECTIONS", 55),
    torrentPort: integer(env, "TORRENT_PORT", 0),
    maxFileBytes: integer(env, "MAX_FILE_GB", 40) * 1024 ** 3,
    maxCacheBytes: integer(env, "MAX_CACHE_GB", 40) * 1024 ** 3,
    downloadLimitBytes: integer(env, "TORRENT_DOWNLOAD_LIMIT_KBPS", -1) * (integer(env, "TORRENT_DOWNLOAD_LIMIT_KBPS", -1) > 0 ? 1024 : 1),
    uploadLimitBytes: integer(env, "TORRENT_UPLOAD_LIMIT_KBPS", 512) * (integer(env, "TORRENT_UPLOAD_LIMIT_KBPS", 512) > 0 ? 1024 : 1),
    sessionIdleMs: integer(env, "SESSION_IDLE_MINUTES", 10) * 60 * 1000,
    torrentLingerMs: integer(env, "TORRENT_LINGER_MINUTES", 3) * 60 * 1000,
    metadataTimeoutMs: integer(env, "METADATA_TIMEOUT_SECONDS", 120) * 1000,
    probeTimeoutMs: integer(env, "PROBE_TIMEOUT_SECONDS", 180) * 1000,
    sweepIntervalMs: integer(env, "SWEEP_INTERVAL_SECONDS", 30) * 1000,
    proxyTimeoutMs: integer(env, "PROXY_TIMEOUT_SECONDS", 15) * 1000,
    // Addons that hand out debrid links can take a long time on the first request.
    sourceTimeoutMs: integer(env, "SOURCE_TIMEOUT_SECONDS", 60) * 1000,
    proxyMaxBytes: integer(env, "PROXY_MAX_MB", 8) * 1024 * 1024,
    invitesFile: env.INVITES_FILE || fileURLToPath(new URL("../invites.json", import.meta.url)),
    requestsFile: env.REQUESTS_FILE || path.join(path.dirname(env.INVITES_FILE || fileURLToPath(new URL("../invites.json", import.meta.url))), "requests.json"),
    signInLinkHosts: list(env, "SIGN_IN_LINK_HOSTS").length ? list(env, "SIGN_IN_LINK_HOSTS") : ["nuvio.tv"]
  };
}
