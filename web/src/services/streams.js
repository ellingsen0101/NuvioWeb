// Classifies addon streams for the browser and picks how each one is played.
import { DirectDebridResolver } from "../../../js/core/debrid/directDebridResolver.js";

const INFO_HASH_RE = /^[0-9a-f]{40}$/i;
const MAGNET_HASH_RE = /xt=urn:btih:([0-9a-f]{40})/i;
const HLS_RE = /\.m3u8(?:[?#]|$)/i;
const PROGRESSIVE_RE = /\.(mp4|m4v|webm|mov)(?:[?#]|$)/i;
const NEEDS_SERVER_RE = /\.(mkv|avi|ts|m2ts|wmv|flv)(?:[?#]|$)/i;

export function streamInfoHash(stream = {}) {
  const value = String(stream.infoHash || "").trim();
  if (INFO_HASH_RE.test(value)) return value.toLowerCase();
  const fromMagnet = String(stream.url || "").match(MAGNET_HASH_RE);
  return fromMagnet ? fromMagnet[1].toLowerCase() : "";
}

// True when the account has a debrid provider that can turn this stream into a direct link.
export function canResolveDebrid(stream, context = {}) {
  try {
    return !stream?.url?.startsWith?.("http") && DirectDebridResolver.canResolveStream(stream, context);
  } catch {
    return false;
  }
}

export function classifyStream(stream = {}, context = {}) {
  if (canResolveDebrid(stream, context)) return "debrid";
  if (streamInfoHash(stream)) return "torrent";
  const url = String(stream.url || "");
  if (/^https?:\/\//i.test(url)) {
    const filename = String(stream.behaviorHints?.filename || "");
    const proxied = Boolean(stream.behaviorHints?.proxyHeaders?.request);
    if (HLS_RE.test(url)) return proxied ? "server" : "hls";
    if (proxied || NEEDS_SERVER_RE.test(url) || NEEDS_SERVER_RE.test(filename)) return "server";
    if (PROGRESSIVE_RE.test(url) || PROGRESSIVE_RE.test(filename)) return "direct";
    return "unknown";
  }
  if (stream.externalUrl) return "external";
  if (stream.ytId) return "youtube";
  return "unsupported";
}

const KIND_LABELS = {
  torrent: "Torrent",
  debrid: "Debrid",
  server: "Needs backend",
  hls: "HLS",
  direct: "Direct",
  unknown: "Direct",
  external: "External",
  youtube: "YouTube",
  unsupported: "Unsupported"
};

export function streamKindLabel(kind) {
  return KIND_LABELS[kind] || kind;
}

export function streamText(stream = {}) {
  const name = String(stream.name || stream.addonName || "Stream").trim();
  const description = String(stream.description || stream.title || "").trim();
  return { name, description };
}

export function detectCapabilities(video = document.createElement("video")) {
  const mse = globalThis.ManagedMediaSource || globalThis.MediaSource;
  const can = (type) =>
    Boolean(mse?.isTypeSupported?.(type)) || ["probably", "maybe"].includes(video.canPlayType(type));
  return {
    hlsNative: Boolean(video.canPlayType("application/vnd.apple.mpegurl")),
    mse: Boolean(mse),
    h264: can('video/mp4; codecs="avc1.640028"'),
    hevc: can('video/mp4; codecs="hvc1.1.6.L120.90"'),
    vp9: can('video/webm; codecs="vp9"'),
    av1: can('video/mp4; codecs="av01.0.08M.08"'),
    aac: can('audio/mp4; codecs="mp4a.40.2"'),
    ac3: can('audio/mp4; codecs="ac-3"'),
    eac3: can('audio/mp4; codecs="ec-3"'),
    opus: can('audio/webm; codecs="opus"')
  };
}
