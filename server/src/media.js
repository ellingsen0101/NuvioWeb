// Decides how a source reaches the browser, and runs ffprobe/ffmpeg when it has to be remuxed.
// ffmpeg only ever reads this service's own loopback file endpoint, never a remote URL, so it
// can't be used to bypass the SSRF checks. Its protocols are limited to match.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    startTime: Number(probe.format?.start_time) || 0,
    videoCodec: video?.codec_name || "",
    videoTag: String(video?.codec_tag_string || "").toLowerCase(),
    width: video?.width || 0,
    height: video?.height || 0,
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

// Apple's players only accept HEVC in MP4 under the hvc1 tag. With hev1 they play audio and no picture.
function isDirectHevc(summary, capabilities) {
  return summary.videoCodec === "hevc" && Boolean(capabilities.hevc) && !/^(hev1|dvhe)$/.test(summary.videoTag || "");
}

export function decidePlayback(summary, capabilities = {}, { allowTranscode = false, canRemux = true, forceRemux = false } = {}) {
  const container = summary.container;
  const video = summary.videoCodec;
  const firstAudio = summary.audioTracks[0]?.codec || "";
  const isMp4 = /mp4|mov/.test(container);
  const isWebm = /webm|matroska/.test(container) && summary.isWebmFile === true;

  if (!forceRemux && isMp4 && (isPlayableH264(summary) || isDirectHevc(summary, capabilities)) && isDirectAudio(firstAudio, capabilities)) {
    return { mode: "direct" };
  }
  if (!forceRemux && isWebm && ((video === "vp9" && capabilities.vp9) || video === "vp8") && isDirectAudio(firstAudio, capabilities)) {
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

// English by default: the first non-commentary track in that language, or else the file's first track.
export function pickDefaultAudio(tracks = [], preferred = "en") {
  const wanted = String(preferred || "en").toLowerCase().slice(0, 2);
  const isCommentary = (track) => /commentary/i.test(track.label || "");
  const matches = (track) => {
    const language = String(track.language || "").toLowerCase();
    if (wanted === "en") return language === "en" || language === "eng" || /\benglish\b/i.test(track.label || "");
    return language.startsWith(wanted);
  };
  return tracks.find((track) => matches(track) && !isCommentary(track)) || tracks.find((track) => !isCommentary(track)) || tracks[0] || null;
}

export function buildHlsArgs({ inputUrl, outputDir: rawOutputDir, start = 0, audioIndex = null, audioCodec = "", decision, canPaceInput = false }) {
  // ffmpeg finds the folder for fMP4's init.mp4 by looking for "/", so on Windows backslash paths
  // would put that file in the working directory instead.
  const outputDir = String(rawOutputDir).replaceAll("\\", "/");
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", INPUT_PROTOCOLS, "-rw_timeout", "120000000"];
  // Copied video can only start on a keyframe, which is usually before the requested time. Keeping
  // the source's timestamps lets firstSegmentTime find where it really starts, for subtitle timing.
  if (decision.video === "copy") args.push("-copyts");
  if (start > 0) args.push("-ss", String(start));
  // Quick to start, then limited to a few times playback speed, so that a stream nobody is watching
  // doesn't download an entire film.
  if (canPaceInput) args.push("-readrate", "3", "-readrate_initial_burst", "60");
  args.push("-i", inputUrl, "-map", "0:v:0");
  args.push("-map", audioIndex != null ? `0:${Number(audioIndex)}` : "0:a:0?");
  args.push("-sn", "-dn");
  if (decision.video === "copy") {
    args.push("-c:v", "copy");
    if (decision.segmentType === "fmp4") {
      // Apple requires hvc1 with its parameter sets in the header. Files tagged hev1 can keep them
      // inside the video instead, so relabelling alone produces a file iPhones can't decode.
      args.push("-tag:v", "hvc1", "-bsf:v", "hevc_mp4toannexb,extract_extradata");
    }
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
  if (decision.video === "copy") args.push("-muxdelay", "0", "-muxpreload", "0");
  else args.push("-avoid_negative_ts", "make_zero");
  args.push(
    "-f", "hls",
    "-hls_time", String(HLS_SEGMENT_SECONDS),
    "-hls_list_size", "0",
    "-hls_playlist_type", "event",
    // Some files have keyframes 30 seconds apart. Splitting by time keeps segments short, so players
    // need far less data before they start. Those segments aren't all independent, so copied video
    // can't claim to be.
    "-hls_flags", decision.video === "copy" ? "split_by_time" : "independent_segments",
    "-hls_segment_type", decision.segmentType,
    "-hls_segment_filename", `${outputDir}/seg%05d.${extension}`,
    `${outputDir}/index.m3u8`
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
      // A playlist still being written looks like a live stream, and players would then begin near
      // its end. This pins playback to the start, which is where the requested position is.
      if (line === "#EXTM3U") return "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES";
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

// Returns the source time of the first video frame in a finished HLS output, in seconds.
export async function firstSegmentTime({ ffprobePath, outputDir }) {
  const playlist = await readFile(path.join(outputDir, "index.m3u8"), "utf8");
  const segment = playlist.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
  if (!segment) return null;
  let target = path.join(outputDir, path.basename(segment));
  if (target.endsWith(".m4s")) {
    // An fMP4 segment can't be read without its init segment.
    const joined = path.join(outputDir, "probe.tmp.mp4");
    const [init, media] = await Promise.all([readFile(path.join(outputDir, "init.mp4")), readFile(target)]);
    await writeFile(joined, Buffer.concat([init, media]));
    target = joined;
  }
  return new Promise((resolve) => {
    const child = spawn(ffprobePath, [
      "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1",
      "-show_entries", "packet=pts_time", "-of", "csv=p=0", target
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const value = parseFloat(stdout);
      resolve(Number.isFinite(value) ? value : null);
    });
  });
}

export function supportsInputPacing(ffmpegPath) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-h", "full"], { stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(text.includes("readrate_initial_burst")));
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
