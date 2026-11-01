// Playback sessions. A session wraps one source (a torrent file or a remote URL) behind a single
// local file endpoint, which the browser or ffmpeg reads, and tracks its lifecycle and limits.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { HlsJob, buildHlsArgs, decidePlayback, directorySize, mimeForName, runProbe, selectFileIndex, summarizeProbe } from "./media.js";
import { isValidInfoHash } from "./torrentEngine.js";
import { UpstreamError, parsePublicUrl, safeGet } from "./netGuard.js";

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
  let activeFfmpeg = 0;

  function touch(session) {
    session.lastActivityAt = Date.now();
  }

  function assertCapacity() {
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

  function fail(session, error) {
    session.state = "error";
    session.code = error.code || "PLAYBACK_FAILED";
    session.message = error.message || "This stream couldn't be started.";
    logger.warn?.(`Playback ${session.id.slice(0, 8)} failed: ${session.code}`);
  }

  function mediaUrl(session, suffix, base = publicBase()) {
    const token = tokens.issueMedia(session.id);
    return `${base}/v1/media/${session.id}/${suffix}?t=${encodeURIComponent(token)}`;
  }

  async function startHls(session, { start = 0, audioIndex = null } = {}) {
    const startAt = Math.max(0, Number(start) || 0);
    const audio =
      session.summary.audioTracks.find((track) => track.index === Number(audioIndex)) || session.summary.audioTracks[0] || null;
    await stopHls(session);
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
        decision: session.decision
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
    return {
      url: mediaUrl(session, `hls/${generation}/index.m3u8`),
      startOffset: startAt
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
      canRemux: tools.ffmpeg
    });
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
    createTorrent(body) {
      if (!config.enableTorrents) throw new ApiError(403, "TORRENTS_DISABLED", "Torrent streaming is turned off on this backend.");
      const infoHash = String(body.infoHash || "").toLowerCase();
      if (!isValidInfoHash(infoHash)) throw new ApiError(400, "INVALID_INFO_HASH", "That isn't a valid torrent hash.");
      assertCapacity();
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

    createUrl(body) {
      let url;
      try {
        url = parsePublicUrl(body.url, { allowPrivate: config.allowPrivateUpstreams });
      } catch (error) {
        throw new ApiError(400, error.code || "INVALID_URL", error.message);
      }
      assertCapacity();
      const session = {
        ...baseSession("url", body),
        url: url.toString(),
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
        audioTracks: session.summary?.audioTracks?.map(({ index, label, detail, language }) => ({ index, label, detail, language })) || [],
        url: session.mode === "hls" ? session.hls.url : mediaUrl(session, "file")
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
        const upstream = await safeGet(session.url, {
          headers: { ...session.headers, ...(rangeHeader ? { range: rangeHeader } : {}) },
          allowPrivate: config.allowPrivateUpstreams,
          timeoutMs: config.proxyTimeoutMs
        });
        const status = upstream.statusCode || 502;
        if (status >= 400) {
          upstream.resume();
          throw new UpstreamError(`The source answered ${status}`, "UPSTREAM_STATUS");
        }
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
