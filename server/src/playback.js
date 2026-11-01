// Playback sessions. A session wraps one source (a torrent file or a remote URL) behind a single
// local file endpoint, which the browser or ffmpeg reads, and tracks its lifecycle and limits.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { HlsJob, buildHlsArgs, decidePlayback, directorySize, firstSegmentTime, mimeForName, pickDefaultAudio, runProbe, selectFileIndex, summarizeProbe } from "./media.js";
import { isValidInfoHash } from "./torrentEngine.js";
import { UpstreamError, parsePublicUrl, safeGet } from "./netGuard.js";

const ABANDONED_AFTER_MS = 30000;
const CONVERSION_ABANDONED_AFTER_MS = 15000;
const RESOLVED_LINK_TTL_MS = 5 * 60 * 1000;
const MAX_RESOLVED_LINKS = 50;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fileFilename(file) {
  return path.basename(file?.name || "");
}

export function createPlaybackManager({ config, engine, tokens, tools, logger = console, publicBase, loopbackBase }) {
  const sessions = new Map();
  // Retrying a source shouldn't pay for the addon's slow redirect a second time.
  const resolvedLinks = new Map();
  let activeFfmpeg = 0;

  function rememberResolvedLink(sourceUrl, finalUrl) {
    if (resolvedLinks.size >= MAX_RESOLVED_LINKS) resolvedLinks.delete(resolvedLinks.keys().next().value);
    resolvedLinks.set(sourceUrl, { url: finalUrl, expiresAt: Date.now() + RESOLVED_LINK_TTL_MS });
  }

  function recallResolvedLink(sourceUrl) {
    const entry = resolvedLinks.get(sourceUrl);
    if (entry && entry.expiresAt > Date.now()) return entry.url;
    resolvedLinks.delete(sourceUrl);
    return null;
  }

  // A conversion left behind by a closed player shouldn't block the one you just asked for. Active
  // players request the playlist every few seconds, so a quiet one has been abandoned.
  async function freeConversionSlot(current) {
    const now = Date.now();
    const idle = [...sessions.values()]
      .filter((other) => other !== current && other.hlsJob?.isRunning() && !other.activeStreams.size && now - other.lastActivityAt > CONVERSION_ABANDONED_AFTER_MS)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    if (idle[0]) {
      logPhase(idle[0], "closed: abandoned conversion");
      await close(idle[0]);
    }
  }

  function touch(session) {
    session.lastActivityAt = Date.now();
  }

  // Phones close apps without saying goodbye, so an abandoned session shouldn't lock anyone out
  // until the idle timeout. When full, the longest-quiet session that isn't sending data makes way.
  async function ensureCapacity() {
    if (sessions.size < config.maxSessions) return;
    const now = Date.now();
    const candidates = [...sessions.values()]
      .filter((session) => !session.activeStreams.size && now - session.lastActivityAt > ABANDONED_AFTER_MS)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    if (candidates[0]) await close(candidates[0]);
    if (sessions.size >= config.maxSessions) {
      throw new ApiError(429, "TOO_MANY_SESSIONS", "The backend is already serving as many streams as it allows.");
    }
  }

  function get(id) {
    const session = sessions.get(id);
    if (!session) throw new ApiError(404, "NOT_FOUND", "This stream has ended.");
    touch(session);
    return session;
  }

  // Timing only. Source URLs and tokens never reach the log.
  function logPhase(session, phase) {
    logger.info?.(`Playback ${session.id.slice(0, 8)} +${((Date.now() - session.createdAt) / 1000).toFixed(1)}s ${phase}`);
  }

  function fail(session, error) {
    session.state = "error";
    session.code = error.code || "PLAYBACK_FAILED";
    // A failed probe usually means the source itself refused or timed out, which is the useful part.
    session.message = session.upstreamError && error.code === "PROBE_FAILED"
      ? `The source didn't provide this video (${session.upstreamError}). Try another source.`
      : error.message || "This stream couldn't be started.";
    logPhase(session, `failed: ${session.code}${session.upstreamError ? ` (${session.upstreamError})` : ""}`);
  }

  function mediaUrl(session, suffix, base = publicBase()) {
    const token = tokens.issueMedia(session.id);
    return `${base}/v1/media/${session.id}/${suffix}?t=${encodeURIComponent(token)}`;
  }

  async function startHls(session, { start = 0, audioIndex = null } = {}) {
    const startAt = Math.max(0, Number(start) || 0);
    const chosenIndex = audioIndex ?? session.audioIndex;
    const audio =
      session.summary.audioTracks.find((track) => track.index === Number(chosenIndex)) ||
      pickDefaultAudio(session.summary.audioTracks, session.preferredAudio);
    session.audioIndex = audio?.index ?? null;
    await stopHls(session);
    if (activeFfmpeg >= config.maxFfmpegProcesses) await freeConversionSlot(session);
    if (activeFfmpeg >= config.maxFfmpegProcesses) {
      throw new ApiError(429, "TOO_MANY_CONVERSIONS", "The backend is already converting as many videos as it allows.");
    }
    session.hlsGeneration += 1;
    const generation = session.hlsGeneration;
    const outputDir = path.join(config.cacheDir, "hls", session.id, String(generation));
    const job = new HlsJob({
      ffmpegPath: config.ffmpegPath,
      outputDir,
      logger,
      args: buildHlsArgs({
        inputUrl: mediaUrl(session, "file", loopbackBase()),
        outputDir,
        start: startAt,
        audioIndex: audio?.index ?? null,
        audioCodec: audio?.codec || "",
        decision: session.decision,
        canPaceInput: tools.inputPacing
      })
    });
    activeFfmpeg += 1;
    let counted = true;
    const uncount = () => {
      if (counted) {
        counted = false;
        activeFfmpeg -= 1;
      }
    };
    await job.start();
    job.child?.once("close", uncount);
    job.child?.once("error", uncount);
    session.hlsJob = job;
    session.startOffset = startAt;
    await job.waitForFirstSegment();
    if (session.hlsGeneration !== generation) throw new ApiError(409, "SUPERSEDED", "A newer seek replaced this one.");
    if (session.decision.video === "copy") {
      const firstFrame = await firstSegmentTime({ ffprobePath: config.ffprobePath, outputDir });
      if (firstFrame != null) session.startOffset = Math.max(0, firstFrame - (session.summary.startTime || 0));
      logPhase(session, `first segment ready, requested ${startAt.toFixed(1)}s, starts at ${session.startOffset.toFixed(1)}s`);
    }
    return {
      url: mediaUrl(session, `hls/${generation}/index.m3u8`),
      startOffset: session.startOffset
    };
  }

  async function stopHls(session) {
    const job = session.hlsJob;
    session.hlsJob = null;
    if (job) await job.stop();
  }

  async function prepare(session) {
    try {
      if (session.kind === "torrent") {
        session.state = "metadata";
        const torrent = await engine.acquire({ infoHash: session.infoHash, sources: session.sources });
        session.holdsTorrent = true;
        if (session.closed) return;
        session.torrent = torrent;
        const files = torrent.files.map((file) => ({ name: file.name, length: file.length }));
        const index = selectFileIndex(files, session.selection);
        if (index < 0) throw Object.assign(new Error("This torrent has no playable video."), { code: "NO_VIDEO_FILE" });
        const file = torrent.files[index];
        if (file.length > config.maxFileBytes) {
          throw Object.assign(new Error("This video is larger than your backend allows."), { code: "FILE_TOO_LARGE" });
        }
        file.select();
        session.file = file;
        session.fileIndex = index;
        session.filename = fileFilename(file);
        session.length = file.length;
      }
      session.state = "probing";
      await resolveMode(session);
    } catch (error) {
      fail(session, error);
    }
  }

  async function resolveMode(session) {
    if (!tools.ffprobe) {
      const name = session.filename.toLowerCase();
      if (/\.(mp4|m4v|webm)$/.test(name)) {
        session.mode = "direct";
        session.state = "ready";
        return;
      }
      throw Object.assign(new Error("This video needs ffmpeg on the backend, and ffmpeg isn't installed."), { code: "REMUX_UNAVAILABLE" });
    }
    const probe = await runProbe({
      ffprobePath: config.ffprobePath,
      inputUrl: mediaUrl(session, "file", loopbackBase()),
      timeoutMs: config.probeTimeoutMs
    });
    if (session.closed) return;
    session.summary = summarizeProbe(probe);
    session.summary.isWebmFile = /\.webm$/i.test(session.filename);
    session.duration = session.summary.duration;
    session.decision = decidePlayback(session.summary, session.capabilities, {
      allowTranscode: config.allowTranscode,
      canRemux: tools.ffmpeg,
      forceRemux: session.forceRemux
    });
    const { container, videoCodec, videoTag, pixFmt, width, height } = session.summary;
    logPhase(session, `probed: ${container} ${videoCodec}/${videoTag} ${pixFmt} ${width}x${height} audio=${session.summary.audioTracks[0]?.codec || "none"} -> ${session.decision.mode}`);
    if (session.decision.mode === "unsupported") {
      throw Object.assign(new Error(session.decision.message), { code: session.decision.code });
    }
    session.mode = session.decision.mode;
    if (session.mode === "hls") {
      session.hls = await startHls(session, { start: session.startAt });
    }
    if (!session.closed) session.state = "ready";
  }

  function baseSession(kind, body) {
    const now = Date.now();
    return {
      id: randomUUID(),
      kind,
      state: "created",
      capabilities: body.capabilities && typeof body.capabilities === "object" ? body.capabilities : {},
      startAt: Math.max(0, Number(body.startAt) || 0),
      forceRemux: body.forceRemux === true,
      preferredAudio: typeof body.preferredAudio === "string" ? body.preferredAudio.slice(0, 8) : "en",
      audioIndex: null,
      createdAt: now,
      lastActivityAt: now,
      hlsGeneration: 0,
      startOffset: 0,
      filename: "",
      closed: false,
      activeStreams: new Set()
    };
  }

  async function close(session) {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.id);
    session.activeStreams.forEach((stream) => stream.destroy());
    await stopHls(session);
    await rm(path.join(config.cacheDir, "hls", session.id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => null);
    if (session.kind === "torrent" && session.holdsTorrent) {
      session.file?.deselect?.();
      engine.release(session.infoHash);
    }
  }

  return {
    async createTorrent(body) {
      if (!config.enableTorrents) throw new ApiError(403, "TORRENTS_DISABLED", "Torrent streaming is turned off on this backend.");
      const infoHash = String(body.infoHash || "").toLowerCase();
      if (!isValidInfoHash(infoHash)) throw new ApiError(400, "INVALID_INFO_HASH", "That isn't a valid torrent hash.");
      await ensureCapacity();
      const session = {
        ...baseSession("torrent", body),
        infoHash,
        sources: Array.isArray(body.sources) ? body.sources : [],
        selection: {
          fileIdx: body.fileIdx ?? null,
          filename: body.filename ?? null,
          season: body.season ?? null,
          episode: body.episode ?? null
        }
      };
      sessions.set(session.id, session);
      prepare(session);
      return { id: session.id, state: session.state };
    },

    async createUrl(body) {
      let url;
      try {
        url = parsePublicUrl(body.url, { allowPrivate: config.allowPrivateUpstreams });
      } catch (error) {
        throw new ApiError(400, error.code || "INVALID_URL", error.message);
      }
      await ensureCapacity();
      const session = {
        ...baseSession("url", body),
        url: url.toString(),
        resolvedUrl: recallResolvedLink(url.toString()),
        headers: body.headers && typeof body.headers === "object" ? body.headers : {},
        filename: path.basename(url.pathname)
      };
      sessions.set(session.id, session);
      prepare(session);
      return { id: session.id, state: session.state };
    },

    get,

    status(id) {
      const session = get(id);
      const torrent = session.torrent;
      const base = {
        id: session.id,
        state: session.state,
        filename: session.filename,
        ...(torrent
          ? {
              name: torrent.name,
              peers: torrent.numPeers,
              downloadSpeed: Math.round(torrent.downloadSpeed),
              uploadSpeed: Math.round(torrent.uploadSpeed),
              progress: session.file ? session.file.progress : torrent.progress,
              fileIndex: session.fileIndex,
              files: torrent.files?.map((file, index) => ({ index, name: fileFilename(file), length: file.length }))
            }
          : {})
      };
      if (session.state === "error") return { ...base, code: session.code, message: session.message };
      if (session.state !== "ready") return base;
      return {
        ...base,
        mode: session.mode,
        duration: session.duration || 0,
        startOffset: session.mode === "hls" ? session.startOffset : 0,
        audioIndex: session.audioIndex,
        info: session.summary
          ? { container: session.summary.container, videoCodec: session.summary.videoCodec, videoTag: session.summary.videoTag, width: session.summary.width, height: session.summary.height }
          : null,
        audioTracks: session.summary?.audioTracks?.map(({ index, label, detail, language }) => ({ index, label, detail, language })) || [],
        url: session.mode === "hls" ? session.hls.url : mediaUrl(session, "file"),
        // The client already holds this source's link. The resolved form skips the slow redirect.
        ...(session.kind === "url" && session.mode === "direct" ? { sourceUrl: session.resolvedUrl || session.url } : {})
      };
    },

    async seekHls(id, body) {
      const session = get(id);
      if (session.mode !== "hls") throw new ApiError(409, "NOT_HLS", "This stream doesn't use HLS.");
      session.hls = await startHls(session, { start: body?.start, audioIndex: body?.audioIndex });
      return session.hls;
    },

    async release(id) {
      const session = sessions.get(id);
      if (session) await close(session);
    },

    // Serves the source bytes with Range support. Returns once the response has been started.
    async serveFile(session, request, response) {
      touch(session);
      const rangeHeader = request.headers.range;
      if (session.kind === "url") {
        const headers_ = { ...session.headers, ...(rangeHeader ? { range: rangeHeader } : {}) };
        const open = (target) =>
          safeGet(target, { headers: headers_, allowPrivate: config.allowPrivateUpstreams, timeoutMs: config.sourceTimeoutMs });
        // Addon links often redirect through a slow resolver to a CDN. Each read goes straight to the
        // CDN after the first, because ffprobe and ffmpeg make many range requests per file.
        let upstream;
        try {
          upstream = await open(session.resolvedUrl || session.url);
          if (session.resolvedUrl && (upstream.statusCode || 500) >= 400) {
            upstream.resume();
            session.resolvedUrl = null;
            resolvedLinks.delete(session.url);
            upstream = await open(session.url);
          }
        } catch (error) {
          session.upstreamError = error.code === "UPSTREAM_TIMEOUT" ? "it timed out" : "it couldn't be reached";
          throw error;
        }
        const status = upstream.statusCode || 502;
        if (status >= 400) {
          upstream.resume();
          session.upstreamError = `it answered ${status}`;
          throw new UpstreamError(`The source answered ${status}`, "UPSTREAM_STATUS");
        }
        if (!session.resolvedUrl) logPhase(session, "source link resolved");
        session.upstreamError = null;
        session.resolvedUrl = upstream.finalUrl;
        rememberResolvedLink(session.url, upstream.finalUrl);
        const headers = {};
        for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
          if (upstream.headers[name]) headers[name] = upstream.headers[name];
        }
        response.writeHead(status, headers);
        if (request.method === "HEAD") {
          upstream.destroy();
          response.end();
          return;
        }
        pipeTracked(session, upstream, response);
        return;
      }

      const { file } = session;
      const total = file.length;
      const headers = {
        "Content-Type": mimeForName(file.name),
        "Accept-Ranges": "bytes"
      };
      let start = 0;
      let end = total - 1;
      let status = 200;
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");
      if (match && (match[1] || match[2])) {
        if (match[1]) {
          start = Number(match[1]);
          if (match[2]) end = Math.min(Number(match[2]), total - 1);
        } else {
          start = Math.max(0, total - Number(match[2]));
        }
        if (start > end || start >= total) {
          response.writeHead(416, { "Content-Range": `bytes */${total}` });
          response.end();
          return;
        }
        status = 206;
        headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
      }
      headers["Content-Length"] = String(end - start + 1);
      response.writeHead(status, headers);
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      pipeTracked(session, file.createReadStream({ start, end }), response);
    },

    hlsFilePath(session, generation, name) {
      if (String(session.hlsGeneration) !== String(generation)) return null;
      if (!/^(index\.m3u8|init\.mp4|seg\d{5}\.(ts|m4s))$/.test(name)) return null;
      return path.join(config.cacheDir, "hls", session.id, String(generation), name);
    },

    async sweep(now = Date.now()) {
      for (const session of [...sessions.values()]) {
        if (now - session.lastActivityAt > config.sessionIdleMs && !session.activeStreams.size) {
          logger.info?.(`Closing idle playback ${session.id.slice(0, 8)}`);
          await close(session);
        }
      }
      await engine.sweep(now);
      const size = await directorySize(config.cacheDir);
      if (size > config.maxCacheBytes) {
        logger.warn?.("Cache limit reached. Removing unused torrents.");
        await engine.evictIdle();
      }
    },

    get size() {
      return sessions.size;
    },

    async destroy() {
      for (const session of [...sessions.values()]) await close(session);
    }
  };

  function pipeTracked(session, source, response) {
    session.activeStreams.add(source);
    const done = () => {
      session.activeStreams.delete(source);
      touch(session);
    };
    source.on("error", (error) => {
      done();
      logger.warn?.(`Stream error: ${error.message}`);
      response.destroy();
    });
    source.on("end", done);
    response.on("close", () => {
      done();
      source.destroy();
    });
    source.pipe(response);
  }
}
