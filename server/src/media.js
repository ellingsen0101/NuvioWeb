// Decides how a source reaches the browser, and runs ffprobe/ffmpeg when it has to be remuxed.
// ffmpeg only ever reads this service's own loopback file endpoint, never a remote URL, so it
// can't be used to bypass the SSRF checks. Its protocols are limited to match.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".ts", ".m2ts", ".mpg", ".mpeg", ".wmv", ".flv"]);
const INPUT_PROTOCOLS = "http,tcp";
const HLS_SEGMENT_SECONDS = 4;
const HLS_READY_TIMEOUT_MS = 120000;

const MIME_BY_EXTENSION = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".ts": "video/mp2t", ".m2ts": "video/mp2t",
  ".mpg": "video/mpeg", ".mpeg": "video/mpeg", ".wmv": "video/x-ms-wmv", ".flv": "video/x-flv"
};

export function mimeForName(name) {
  return MIME_BY_EXTENSION[path.extname(String(name || "")).toLowerCase()] || "application/octet-stream";
}

export function isVideoName(name) {
  return VIDEO_EXTENSIONS.has(path.extname(String(name || "")).toLowerCase());
}

// Chooses the file to play: an explicit index, then the addon's filename hint, then the matching
// episode in a season pack, then the largest video.
export function selectFileIndex(files, { fileIdx = null, filename = null, season = null, episode = null } = {}) {
  const index = Number(fileIdx);
  if (fileIdx !== null && fileIdx !== "" && Number.isInteger(index) && index >= 0 && index < files.length) return index;
  const videos = files.map((file, i) => ({ ...file, index: i })).filter((file) => isVideoName(file.name));
  if (!videos.length) return -1;
  if (filename) {
    const wanted = String(filename).toLowerCase();
    const exact = videos.find((file) => path.basename(file.name).toLowerCase() === wanted);
    if (exact) return exact.index;
  }
  const largest = (candidates) => candidates.reduce((best, file) => (file.length > best.length ? file : best)).index;
  const s = Number(season);
  const e = Number(episode);
  if (season != null && episode != null && Number.isFinite(s) && Number.isFinite(e)) {
    const pattern = new RegExp(`(?:^|[^a-z0-9])s0*${s}[ ._-]*e0*${e}(?![0-9])|(?:^|[^0-9])0*${s}x0*${e}(?![0-9])`, "i");
    const matches = videos.filter((file) => pattern.test(path.basename(file.name)));
    if (matches.length) return largest(matches);
  }
  return largest(videos);
}

export function summarizeProbe(probe = {}) {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1) || null;
  const describe = (stream) => {
    const language = stream.tags?.language && stream.tags.language !== "und" ? stream.tags.language : "";
    const channels = stream.channels ? `${stream.channels}ch` : "";
    return {
      index: stream.index,
      codec: stream.codec_name || "",
      language,
      label: stream.tags?.title || language || `Track ${stream.index}`,
      detail: [String(stream.codec_name || "").toUpperCase(), channels].filter(Boolean).join(" ")
    };
  };
  return {
    container: String(probe.format?.format_name || ""),
    duration: Number(probe.format?.duration) || 0,
    videoCodec: video?.codec_name || "",
    pixFmt: video?.pix_fmt || "",
    audioTracks: streams.filter((stream) => stream.codec_type === "audio").map(describe),
    subtitleTracks: streams.filter((stream) => stream.codec_type === "subtitle").map(describe)
  };
}

const BROWSER_AUDIO = new Set(["aac", "mp3"]);

function isDirectAudio(codec, capabilities) {
  if (!codec) return true;
  if (BROWSER_AUDIO.has(codec)) return true;
  if (codec === "ac3") return Boolean(capabilities.ac3);
  if (codec === "eac3") return Boolean(capabilities.eac3);
  if (codec === "opus" || codec === "vorbis") return Boolean(capabilities.opus);
  return false;
}

// 8-bit H.264 plays nearly everywhere. 10-bit H.264 mostly doesn't, whatever canPlayType reports.
function isPlayableH264(summary) {
  return summary.videoCodec === "h264" && !/10le|12le/.test(summary.pixFmt);
}

export function decidePlayback(summary, capabilities = {}, { allowTranscode = false, canRemux = true } = {}) {
  const container = summary.container;
  const video = summary.videoCodec;
  const firstAudio = summary.audioTracks[0]?.codec || "";
  const isMp4 = /mp4|mov/.test(container);
  const isWebm = /webm|matroska/.test(container) && summary.isWebmFile === true;

  if (isMp4 && (isPlayableH264(summary) || (video === "hevc" && capabilities.hevc)) && isDirectAudio(firstAudio, capabilities)) {
    return { mode: "direct" };
  }
  if (isWebm && ((video === "vp9" && capabilities.vp9) || video === "vp8") && isDirectAudio(firstAudio, capabilities)) {
    return { mode: "direct" };
  }
  if (!canRemux) {
    return { mode: "unsupported", code: "REMUX_UNAVAILABLE", message: "This video needs ffmpeg on the backend, and ffmpeg isn't installed." };
  }
  if (isPlayableH264(summary)) return { mode: "hls", video: "copy", segmentType: "mpegts" };
  if (video === "hevc" && capabilities.hevc && !/12le/.test(summary.pixFmt)) return { mode: "hls", video: "copy", segmentType: "fmp4" };
  if (!video) return { mode: "unsupported", code: "NO_VIDEO", message: "This file has no video track." };
  if (allowTranscode) return { mode: "hls", video: "transcode", segmentType: "mpegts" };
  return {
    mode: "unsupported",
    code: "TRANSCODE_DISABLED",
    message: `This video uses ${video.toUpperCase()}, which this device can't play, and transcoding is off on your backend. Try a source encoded as H.264.`
  };
}

export function buildHlsArgs({ inputUrl, outputDir, start = 0, audioIndex = null, audioCodec = "", decision }) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", INPUT_PROTOCOLS, "-rw_timeout", "120000000"];
  if (start > 0) args.push("-ss", String(start));
  args.push("-i", inputUrl, "-map", "0:v:0");
  args.push("-map", audioIndex != null ? `0:${Number(audioIndex)}` : "0:a:0?");
  args.push("-sn", "-dn");
  if (decision.video === "copy") {
    args.push("-c:v", "copy");
    if (decision.segmentType === "fmp4") args.push("-tag:v", "hvc1");
  } else {
    args.push(
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-vf", "scale=-2:'min(ih,1080)'",
      "-force_key_frames", `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`
    );
  }
  if (audioCodec === "aac") args.push("-c:a", "copy");
  else args.push("-c:a", "aac", "-ac", "2", "-b:a", "160k");
  const extension = decision.segmentType === "fmp4" ? "m4s" : "ts";
  args.push(
    "-avoid_negative_ts", "make_zero",
    "-f", "hls",
    "-hls_time", String(HLS_SEGMENT_SECONDS),
    "-hls_list_size", "0",
    "-hls_playlist_type", "event",
    "-hls_flags", "independent_segments",
    "-hls_segment_type", decision.segmentType,
    "-hls_segment_filename", path.join(outputDir, `seg%05d.${extension}`),
    path.join(outputDir, "index.m3u8")
  );
  return args;
}

// Appends the media token to every URI in a playlist, including fMP4 init segments.
export function rewritePlaylist(text, token) {
  const query = `?t=${encodeURIComponent(token)}`;
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (line.startsWith("#EXT-X-MAP:")) {
        return line.replace(/URI="([^"]+)"/, (_, uri) => `URI="${path.basename(uri)}${query}"`);
      }
      if (line.startsWith("#")) return line;
      return `${path.basename(line)}${query}`;
    })
    .join("\n");
}

export function runProbe({ ffprobePath, inputUrl, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, [
      "-v", "error", "-protocol_whitelist", INPUT_PROTOCOLS, "-print_format", "json",
      "-show_format", "-show_streams", "-rw_timeout", "60000000", inputUrl
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Object.assign(new Error("Reading the video's details took too long. It may have too few peers."), { code: "PROBE_TIMEOUT" }));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`ffprobe couldn't start: ${error.message}`), { code: "FFPROBE_MISSING" }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(Object.assign(new Error("The video's details couldn't be read."), { code: "PROBE_FAILED", detail: stderr }));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(Object.assign(new Error("The video's details couldn't be read."), { code: "PROBE_FAILED" }));
      }
    });
  });
}

export function isToolAvailable(binary) {
  return new Promise((resolve) => {
    const child = spawn(binary, ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export class HlsJob {
  constructor({ ffmpegPath, outputDir, args, logger }) {
    this.outputDir = outputDir;
    this.ffmpegPath = ffmpegPath;
    this.args = args;
    this.logger = logger;
    this.child = null;
    this.exitCode = undefined;
    this.stderr = "";
  }

  async start() {
    await mkdir(this.outputDir, { recursive: true });
    this.child = spawn(this.ffmpegPath, this.args, { stdio: ["ignore", "ignore", "pipe"] });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    this.child.on("error", (error) => {
      this.exitCode = -1;
      this.stderr = error.message;
    });
    this.child.on("close", (code) => {
      this.exitCode = code ?? -1;
      if (code) this.logger?.warn?.(`ffmpeg exited with code ${code}`);
    });
  }

  // Ready means the playlist lists at least one finished segment.
  async waitForFirstSegment(timeoutMs = HLS_READY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    const playlist = path.join(this.outputDir, "index.m3u8");
    while (Date.now() < deadline) {
      const text = await readFile(playlist, "utf8").catch(() => "");
      if (/^[^#\s].*$/m.test(text)) return;
      if (this.exitCode !== undefined && this.exitCode !== 0) {
        throw Object.assign(new Error("The video couldn't be converted."), { code: "REMUX_FAILED", detail: this.stderr });
      }
      if (this.exitCode === 0 && !text) throw Object.assign(new Error("The video couldn't be converted."), { code: "REMUX_FAILED" });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw Object.assign(new Error("Converting the video took too long. The source may be too slow."), { code: "REMUX_TIMEOUT" });
  }

  isRunning() {
    return Boolean(this.child) && this.exitCode === undefined;
  }

  async stop() {
    if (this.isRunning()) {
      await new Promise((resolve) => {
        this.child.once("close", resolve);
        this.child.kill("SIGKILL");
        setTimeout(resolve, 3000);
      });
    }
    await rm(this.outputDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => null);
  }
}

export async function directorySize(directory) {
  const { readdir } = await import("node:fs/promises");
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else total += (await stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}
