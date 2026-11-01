import { subtitleRepository } from "../../../js/data/repository/subtitleRepository.js";
import { watchProgressRepository } from "../../../js/data/repository/watchProgressRepository.js";
import { PlayerSettingsStore } from "../../../js/data/local/playerSettingsStore.js";
import { button, clear, formatDuration, h, icon, iconButton, openSheet, toast } from "../lib/dom.js";
import { goBack, navigate } from "../lib/router.js";
import { Backend, BackendError } from "../services/backend.js";
import { classifyStream, detectCapabilities, streamInfoHash, streamText } from "../services/streams.js";
import { clearPendingPlayback, getPendingPlayback, setPendingPlayback } from "../services/playerState.js";
import { createEngine, describeMediaError } from "./engine.js";
import { cueAt, loadSubtitleCues } from "./subtitles.js";

const CONTROLS_HIDE_MS = 3500;
const PROGRESS_SAVE_MS = 15000;
const STATUS_POLL_MS = 1500;
const SEEK_STEP_S = 10;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const COMPLETED_FRACTION = 0.9;

function languageName(code) {
  try {
    return new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(code) || code;
  } catch {
    return code || "Unknown";
  }
}

function formatRate(bytesPerSecond) {
  const value = Number(bytesPerSecond || 0);
  if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MB/s`;
  return `${Math.round(value / 1024)} KB/s`;
}

export function mountPlayer(node, route) {
  const session = getPendingPlayback();
  if (!session) {
    // Stream URLs aren't stored, so a reload returns to the title instead of failing.
    navigate("detail", route.segments, null, { replace: true });
    return () => {};
  }
  const { meta, video: episode, stream, resumeMs = 0, episodes = [] } = session;
  const kind = session.kind || classifyStream(stream);
  const controller = new AbortController();
  let disposed = false;

  // Remuxed backend HLS may start mid-file, so the file position is timeOffset + currentTime.
  let timeOffset = 0;
  let knownDuration = 0;
  let playbackId = null;
  let isBackendHls = false;
  let audioIndex = null;
  let backendAudio = [];
  let cues = [];
  let subtitleDelayS = 0;
  let selectedSubtitle = null;
  let subtitleOptions = [];
  let hideTimer = 0;
  let scrubbing = false;
  let lastSavedAt = 0;
  let pendingResumeS = resumeMs > 0 ? resumeMs / 1000 : 0;
  let triedBackendFallback = false;
  let statusTimer = 0;
  let wakeLock = null;
  let nativeTrack = null;

  const video = h("video", {
    class: "player-video",
    playsInline: true,
    preload: "auto",
    crossOrigin: null,
    "webkit-playsinline": "true",
    "x-webkit-airplay": "allow"
  });
  video.setAttribute("playsinline", "");

  const title = episode ? `${meta.name} · S${episode.season} E${episode.episode}` : meta.name;
  const subtitleLayer = h("div", { class: "player-subs", "aria-live": "off" });
  const buffering = h(
    "div",
    { class: "player-buffering" },
    h("div", { class: "spinner" }),
    h("p", { class: "player-status" }, "Loading…")
  );
  const statusText = buffering.querySelector(".player-status");
  const errorBox = h("div", { class: "player-error", hidden: true });
  const playIcon = icon("play_arrow", { filled: true });
  const playButton = h("button", { type: "button", class: "player-play", "aria-label": "Play or pause", onClick: () => togglePlay() }, playIcon);
  const timeNow = h("span", { class: "player-time" }, "0:00");
  const timeEnd = h("span", { class: "player-time" }, "0:00");
  const scrubber = h("input", { type: "range", class: "player-scrubber", min: 0, max: 1000, value: 0, step: 1, "aria-label": "Seek" });
  const bufferedBar = h("div", { class: "player-buffered" });
  const nextEpisode = nextEpisodeOf();

  const topBar = h(
    "div",
    { class: "player-top" },
    iconButton("arrow_back", "Back", () => exit()),
    h("div", { class: "player-title" }, h("strong", {}, title), episode?.title ? h("span", {}, episode.title) : null)
  );
  const bottomBar = h(
    "div",
    { class: "player-bottom" },
    h("div", { class: "player-seek" }, timeNow, h("div", { class: "player-track" }, bufferedBar, scrubber), timeEnd),
    h(
      "div",
      { class: "player-buttons" },
      iconButton("subtitles", "Subtitles", () => openSubtitles()),
      iconButton("graphic_eq", "Audio", () => openAudio()),
      iconButton("speed", "Speed", () => openSpeed()),
      nextEpisode ? iconButton("skip_next", "Next episode", () => playNext()) : null,
      h("span", { class: "player-spacer" }),
      "pictureInPictureEnabled" in document || video.webkitSupportsPresentationMode
        ? iconButton("picture_in_picture_alt", "Picture in picture", () => togglePip())
        : null,
      iconButton("fullscreen", "Fullscreen", () => toggleFullscreen())
    )
  );
  const gestures = h("div", { class: "player-gestures" });
  const skipHint = h("div", { class: "player-skip-hint", hidden: true });
  const root = h(
    "div",
    { class: "player-root is-loading", tabIndex: 0 },
    video,
    subtitleLayer,
    gestures,
    skipHint,
    h("div", { class: "player-center" }, playButton),
    buffering,
    errorBox,
    h("div", { class: "player-chrome" }, topBar, bottomBar)
  );
  node.append(root);

  const engine = createEngine(video, {
    onFatal: (message) => showError(message),
    onTracks: () => {}
  });

  function nextEpisodeOf() {
    if (!episode || !episodes.length) return null;
    const index = episodes.findIndex((entry) => entry.id === episode.id);
    return index >= 0 ? episodes[index + 1] || null : null;
  }

  function position() {
    return timeOffset + (video.currentTime || 0);
  }

  function duration() {
    if (knownDuration > 0) return knownDuration;
    return Number.isFinite(video.duration) ? timeOffset + video.duration : 0;
  }

  function setBuffering(active, message) {
    root.classList.toggle("is-loading", active);
    if (message) statusText.textContent = message;
    else if (active) statusText.textContent = "Buffering…";
  }

  function showError(message, { retry = true } = {}) {
    if (disposed) return;
    root.classList.remove("is-loading");
    saveProgress(true);
    clear(errorBox).append(
      icon("error"),
      h("p", {}, message),
      h(
        "div",
        { class: "player-error-actions" },
        retry ? button("Try again", () => restart(), { kind: "primary" }) : null,
        button("Choose another source", () => exit(), { kind: "secondary" })
      )
    );
    errorBox.hidden = false;
  }

  function showControls() {
    root.classList.add("show-chrome");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!video.paused && !scrubbing && !document.querySelector(".player-root .sheet-backdrop")) {
        root.classList.remove("show-chrome");
      }
    }, CONTROLS_HIDE_MS);
  }

  function togglePlay() {
    if (video.paused) video.play().catch(onPlayRejected);
    else video.pause();
    showControls();
  }

  function onPlayRejected(error) {
    // Autoplay without a gesture is refused on iOS. The play button stays visible for a tap.
    if (error?.name === "NotAllowedError") {
      root.classList.remove("is-loading");
      root.classList.add("show-chrome", "needs-tap");
    } else if (error?.name !== "AbortError") {
      console.warn("Play rejected", error);
    }
  }

  async function seekTo(seconds) {
    const total = duration();
    const target = Math.max(0, total > 0 ? Math.min(seconds, total - 1) : seconds);
    if (isBackendHls && playbackId) {
      const relative = target - timeOffset;
      const end = video.seekable?.length ? video.seekable.end(video.seekable.length - 1) : 0;
      if (relative < 0 || relative > end) {
        await restartHlsAt(target);
        return;
      }
      video.currentTime = relative;
      return;
    }
    video.currentTime = target;
  }

  async function restartHlsAt(seconds, nextAudio = audioIndex) {
    setBuffering(true, "Seeking…");
    try {
      const result = await Backend.startHls(playbackId, { start: seconds, audioIndex: nextAudio });
      if (disposed) return;
      audioIndex = nextAudio;
      timeOffset = result.startOffset || 0;
      syncNativeTrack();
      await engine.load({ url: result.url, kind: "hls" });
      video.play().catch(onPlayRejected);
    } catch (error) {
      showError(error?.message || "Seeking failed.");
    }
  }

  function skip(deltaS, side) {
    seekTo(position() + deltaS);
    skipHint.textContent = `${deltaS > 0 ? "+" : "−"}${Math.abs(deltaS)}s`;
    skipHint.dataset.side = side;
    skipHint.hidden = false;
    clearTimeout(skipHint.__timer);
    skipHint.__timer = setTimeout(() => {
      skipHint.hidden = true;
    }, 600);
  }

  function renderTimeline() {
    const total = duration();
    const current = position();
    if (!scrubbing) {
      timeNow.textContent = formatDuration(current * 1000);
      scrubber.value = total > 0 ? String(Math.round((current / total) * 1000)) : "0";
    }
    timeEnd.textContent = total > 0 ? formatDuration(total * 1000) : "--:--";
    if (total > 0 && video.buffered.length) {
      const end = timeOffset + video.buffered.end(video.buffered.length - 1);
      bufferedBar.style.width = `${Math.min(100, (end / total) * 100)}%`;
    }
    renderSubtitle(current);
  }

  function renderSubtitle(current) {
    if (!cues.length) {
      if (subtitleLayer.childElementCount) clear(subtitleLayer);
      return;
    }
    const active = cueAt(cues, current - subtitleDelayS);
    const text = active.map((cue) => cue.text).join("\n");
    if (subtitleLayer.dataset.text !== text) {
      subtitleLayer.dataset.text = text;
      clear(subtitleLayer);
      if (text) subtitleLayer.append(h("span", { class: "player-sub-line" }, text));
    }
  }

  // Native fullscreen on iPhone can only show real text tracks, so cues are mirrored into one.
  function syncNativeTrack() {
    if (!nativeTrack) nativeTrack = video.addTextTrack("subtitles", "Subtitles", "und");
    const existing = nativeTrack.cues ? Array.from(nativeTrack.cues) : [];
    existing.forEach((cue) => nativeTrack.removeCue(cue));
    const Cue = globalThis.VTTCue || globalThis.TextTrackCue;
    if (!Cue) return;
    cues.forEach((cue) => {
      const start = cue.start + subtitleDelayS - timeOffset;
      const end = cue.end + subtitleDelayS - timeOffset;
      if (end > 0) nativeTrack.addCue(new Cue(Math.max(0, start), end, cue.text));
    });
    nativeTrack.mode = video.webkitDisplayingFullscreen ? "showing" : "hidden";
  }

  function saveProgress(force = false) {
    const total = duration();
    const current = position();
    if (total <= 0 || current <= 0) return;
    const now = Date.now();
    if (!force && now - lastSavedAt < PROGRESS_SAVE_MS) return;
    lastSavedAt = now;
    watchProgressRepository
      .saveProgress({
        contentId: meta.id,
        contentType: meta.type,
        videoId: episode?.id || null,
        season: episode?.season ?? null,
        episode: episode?.episode ?? null,
        episodeTitle: episode?.title || null,
        title: meta.name,
        poster: meta.poster || null,
        backdrop: meta.background || null,
        logo: meta.logo || null,
        positionMs: Math.round(current * 1000),
        durationMs: Math.round(total * 1000),
        updatedAt: now
      })
      .catch((error) => console.warn("Progress save failed", error));
  }

  function picker(titleText, options, onSelect, extra = null) {
    const sheet = openSheet({
      title: titleText,
      className: "sheet-player",
      content: h(
        "div",
        { class: "picker" },
        extra,
        options.length
          ? options.map((option) =>
              h(
                "button",
                {
                  type: "button",
                  class: `picker-item ${option.active ? "is-active" : ""}`,
                  onClick: () => {
                    onSelect(option);
                    sheet.close();
                    showControls();
                  }
                },
                h("span", {}, option.label, option.detail ? h("small", {}, option.detail) : null),
                option.active ? icon("check") : null
              )
            )
          : h("p", { class: "muted" }, "None available for this video.")
      )
    });
  }

  async function selectSubtitle(option) {
    if (!option?.url) {
      selectedSubtitle = null;
      cues = [];
      syncNativeTrack();
      renderTimeline();
      return;
    }
    try {
      statusText.textContent = "Loading subtitles…";
      cues = await loadSubtitleCues(option.url, { signal: controller.signal });
      selectedSubtitle = option;
      subtitleLayer.dataset.text = "";
      syncNativeTrack();
      renderTimeline();
    } catch (error) {
      if (error?.name !== "AbortError") toast(`Subtitles couldn't load: ${error?.message || "unknown error"}`, { error: true });
    }
  }

  function openSubtitles() {
    const delayLabel = h("span", { class: "delay-value" }, `${subtitleDelayS.toFixed(1)}s`);
    const adjust = (delta) => {
      subtitleDelayS = Math.round((subtitleDelayS + delta) * 10) / 10;
      delayLabel.textContent = `${subtitleDelayS.toFixed(1)}s`;
      syncNativeTrack();
      renderTimeline();
    };
    const delayControls = h(
      "div",
      { class: "delay-row" },
      h("span", {}, "Timing"),
      iconButton("remove", "Show subtitles earlier", () => adjust(-0.5)),
      delayLabel,
      iconButton("add", "Show subtitles later", () => adjust(0.5))
    );
    picker(
      "Subtitles",
      [
        { label: "Off", active: !selectedSubtitle },
        ...subtitleOptions.map((option) => ({ ...option, active: selectedSubtitle?.url === option.url }))
      ],
      selectSubtitle,
      delayControls
    );
  }

  function openAudio() {
    const nativeTracks = engine.audioTracks();
    if (isBackendHls && backendAudio.length) {
      picker(
        "Audio",
        backendAudio.map((track) => ({
          label: track.label,
          detail: track.detail,
          id: track.index,
          active: (audioIndex ?? backendAudio[0]?.index) === track.index
        })),
        (option) => restartHlsAt(position(), option.id)
      );
      return;
    }
    picker(
      "Audio",
      nativeTracks.map((track) => ({ ...track, detail: track.language && track.label !== track.language ? track.language : "" })),
      (option) => engine.selectAudio(option.id)
    );
  }

  function openSpeed() {
    picker(
      "Playback speed",
      SPEEDS.map((value) => ({ label: value === 1 ? "Normal" : `${value}×`, value, active: video.playbackRate === value })),
      (option) => {
        video.playbackRate = option.value;
      }
    );
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
        screen.orientation?.unlock?.();
        return;
      }
      if (root.requestFullscreen) {
        await root.requestFullscreen();
        await screen.orientation?.lock?.("landscape").catch(() => null);
      } else if (root.webkitRequestFullscreen) {
        root.webkitRequestFullscreen();
      } else if (video.webkitEnterFullscreen) {
        // iPhone Safari only allows fullscreen on the video element itself.
        video.webkitEnterFullscreen();
      } else {
        toast("Fullscreen isn't available here");
      }
    } catch (error) {
      if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else toast(error?.message || "Fullscreen isn't available here");
    }
  }

  async function togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (video.requestPictureInPicture) await video.requestPictureInPicture();
      else if (video.webkitSetPresentationMode) {
        video.webkitSetPresentationMode(video.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture");
      }
    } catch (error) {
      toast(error?.message || "Picture in picture isn't available", { error: true });
    }
  }

  async function requestWakeLock() {
    try {
      wakeLock = await navigator.wakeLock?.request?.("screen");
    } catch {
      wakeLock = null;
    }
  }

  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist: episode?.title || "Nuvio",
      artwork: meta.poster ? [{ src: meta.poster, sizes: "512x512", type: "image/jpeg" }] : []
    });
    const handlers = {
      play: () => video.play().catch(onPlayRejected),
      pause: () => video.pause(),
      seekbackward: () => seekTo(position() - SEEK_STEP_S),
      seekforward: () => seekTo(position() + SEEK_STEP_S)
    };
    Object.entries(handlers).forEach(([action, handler]) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Not every browser implements every action.
      }
    });
  }

  function exit() {
    goBack("home");
  }

  function playNext() {
    saveProgress(true);
    // The next episode needs its own stream lookup, so it returns to the title's source picker.
    navigate("detail", [meta.type, meta.id], { play: 1, video: nextEpisode.id }, { replace: true });
  }

  function restart() {
    errorBox.hidden = true;
    setPendingPlayback({ ...session, resumeMs: Math.round(position() * 1000) || resumeMs });
    pendingResumeS = position() || pendingResumeS;
    startSource();
  }

  async function pollTorrent(id) {
    if (disposed) return null;
    const state = await Backend.getPlayback(id, { signal: controller.signal });
    if (disposed) return null;
    if (state.state === "error") throw new BackendError(state.message || "The stream failed", { code: state.code });
    if (state.state === "ready") return state;
    const parts = [
      state.state === "metadata" ? "Finding peers…" : "Preparing video…",
      state.peers ? `${state.peers} peers` : null,
      state.downloadSpeed ? formatRate(state.downloadSpeed) : null
    ].filter(Boolean);
    setBuffering(true, parts.join("  ·  "));
    await new Promise((resolve) => {
      statusTimer = setTimeout(resolve, STATUS_POLL_MS);
    });
    return pollTorrent(id);
  }

  async function startBackendPlayback() {
    const capabilities = detectCapabilities(video);
    const body = {
      capabilities,
      startAt: pendingResumeS || 0
    };
    const infoHash = streamInfoHash(stream);
    const created = infoHash
      ? await Backend.createTorrentPlayback(
          {
            ...body,
            infoHash,
            sources: stream.sources || [],
            fileIdx: stream.fileIdx ?? null,
            filename: stream.behaviorHints?.filename || null,
            season: episode?.season ?? null,
            episode: episode?.episode ?? null
          },
          { signal: controller.signal }
        )
      : await Backend.createUrlPlayback(
          { ...body, url: stream.url, headers: stream.behaviorHints?.proxyHeaders?.request || null },
          { signal: controller.signal }
        );
    playbackId = created.id;
    const ready = await pollTorrent(created.id);
    if (!ready || disposed) return;
    knownDuration = Number(ready.duration || 0);
    isBackendHls = ready.mode === "hls";
    backendAudio = ready.audioTracks || [];
    timeOffset = isBackendHls ? Number(ready.startOffset || 0) : 0;
    if (isBackendHls) pendingResumeS = 0;
    await engine.load({ url: ready.url, kind: ready.mode === "hls" ? "hls" : "direct" });
  }

  async function startSource() {
    if (disposed) return;
    setBuffering(true, "Loading…");
    errorBox.hidden = true;
    try {
      const sourceKind = classifyStream(stream);
      const needsBackend = sourceKind === "torrent" || sourceKind === "server" || triedBackendFallback;
      if (needsBackend) {
        if (!Backend.isConnected()) {
          showError("This source needs your streaming backend. Connect it in Settings, then try again.", { retry: false });
          return;
        }
        await startBackendPlayback();
      } else {
        await engine.load({ url: stream.url, kind: sourceKind === "hls" ? "hls" : "direct" });
      }
      video.play().catch(onPlayRejected);
    } catch (error) {
      if (error?.name === "AbortError" || disposed) return;
      showError(error?.message || "This source couldn't be started.");
    }
  }

  async function loadSubtitleOptions() {
    const sidecar = (stream.subtitles || []).map((entry) => ({
      url: entry.url,
      label: languageName(entry.lang),
      detail: "From this source",
      lang: entry.lang
    }));
    subtitleOptions = sidecar;
    const results = await subtitleRepository
      .getSubtitles(meta.type, meta.id, episode?.id || null, {
        title: meta.name,
        year: meta.releaseInfo,
        season: episode?.season,
        episode: episode?.episode,
        filename: stream.behaviorHints?.filename,
        videoHash: stream.behaviorHints?.videoHash,
        videoSize: stream.behaviorHints?.videoSize
      })
      .catch((error) => {
        console.warn("Subtitle lookup failed", error);
        return [];
      });
    if (disposed) return;
    subtitleOptions = [
      ...sidecar,
      ...results.map((entry) => ({
        url: entry.url,
        label: languageName(entry.lang),
        detail: entry.addonName || "",
        lang: entry.lang
      }))
    ];
    const settings = PlayerSettingsStore.get();
    const preferred = String(settings?.subtitleStyle?.preferredLanguage || "off").toLowerCase();
    if (preferred !== "off") {
      const match = subtitleOptions.find((option) => {
        const language = String(option.lang || "").toLowerCase();
        return language === preferred || language.startsWith(preferred) || preferred.startsWith(language.slice(0, 2));
      });
      if (match) selectSubtitle(match);
    }
  }

  // Events
  const listeners = [
    ["loadedmetadata", () => {
      if (pendingResumeS > 0) {
        const target = pendingResumeS;
        pendingResumeS = 0;
        video.currentTime = target;
      }
      renderTimeline();
    }],
    ["timeupdate", () => {
      renderTimeline();
      saveProgress();
    }],
    ["durationchange", renderTimeline],
    ["progress", renderTimeline],
    ["waiting", () => setBuffering(true)],
    ["stalled", () => { if (video.readyState < 3) setBuffering(true); }],
    ["seeking", () => setBuffering(true, "Seeking…")],
    ["canplay", () => setBuffering(false)],
    ["seeked", () => {
      if (video.readyState >= 3) setBuffering(false);
      saveProgress(true);
    }],
    ["playing", () => {
      setBuffering(false);
      root.classList.remove("needs-tap");
      playIcon.textContent = "pause";
      requestWakeLock();
      showControls();
    }],
    ["pause", () => {
      playIcon.textContent = "play_arrow";
      root.classList.add("show-chrome");
      saveProgress(true);
      wakeLock?.release?.().catch(() => null);
    }],
    ["ended", () => {
      saveProgress(true);
      if (nextEpisode) playNext();
      else if (!isBackendHls || position() >= duration() - 5) exit();
    }],
    ["error", () => {
      const code = video.error?.code;
      // A format the browser refused gets one automatic retry through the backend, when connected.
      if ((code === 4 || code === 3) && !triedBackendFallback && !playbackId && Backend.isConnected() && /^https?:/i.test(stream.url || "")) {
        triedBackendFallback = true;
        setBuffering(true, "Converting for this device…");
        startSource();
        return;
      }
      showError(describeMediaError(video));
    }],
    ["webkitbeginfullscreen", () => { if (nativeTrack) nativeTrack.mode = "showing"; }],
    ["webkitendfullscreen", () => { if (nativeTrack) nativeTrack.mode = "hidden"; }]
  ];
  listeners.forEach(([type, handler]) => video.addEventListener(type, handler));

  scrubber.addEventListener("input", () => {
    scrubbing = true;
    const target = (Number(scrubber.value) / 1000) * duration();
    timeNow.textContent = formatDuration(target * 1000);
    showControls();
  });
  scrubber.addEventListener("change", () => {
    scrubbing = false;
    seekTo((Number(scrubber.value) / 1000) * duration());
  });

  // Single tap toggles the controls. Double tap on either side skips, as in the Android app.
  let lastTap = { time: 0, x: 0 };
  gestures.addEventListener("click", (event) => {
    const now = Date.now();
    const rect = gestures.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const side = x < rect.width / 2 ? "left" : "right";
    if (now - lastTap.time < 300 && Math.abs(event.clientX - lastTap.x) < 80) {
      clearTimeout(gestures.__single);
      lastTap = { time: 0, x: 0 };
      skip(side === "left" ? -SEEK_STEP_S : SEEK_STEP_S, side);
      return;
    }
    lastTap = { time: now, x: event.clientX };
    clearTimeout(gestures.__single);
    gestures.__single = setTimeout(() => {
      if (root.classList.contains("show-chrome") && !video.paused) root.classList.remove("show-chrome");
      else showControls();
    }, 280);
  });
  root.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse") showControls();
  });

  const onKey = (event) => {
    if (event.target?.tagName === "INPUT" && event.target.type !== "range") return;
    const actions = {
      " ": () => togglePlay(),
      k: () => togglePlay(),
      ArrowLeft: () => skip(-SEEK_STEP_S, "left"),
      ArrowRight: () => skip(SEEK_STEP_S, "right"),
      f: () => toggleFullscreen(),
      c: () => openSubtitles(),
      m: () => {
        video.muted = !video.muted;
      },
      Escape: () => {
        if (!document.fullscreenElement && !document.querySelector(".sheet-backdrop")) exit();
      }
    };
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
      showControls();
    }
  };
  document.addEventListener("keydown", onKey);

  const onPageHide = () => saveProgress(true);
  const onVisibility = () => {
    if (document.visibilityState === "hidden") saveProgress(true);
    else if (!video.paused) requestWakeLock();
  };
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);

  document.documentElement.classList.add("player-active");
  showControls();
  setupMediaSession();
  startSource();
  loadSubtitleOptions();
  // Fix the title for toasts and desktop tabs.
  const previousTitle = document.title;
  document.title = `${streamText(stream).name ? title : title} · Nuvio`;

  return () => {
    disposed = true;
    saveProgress(true);
    controller.abort();
    clearTimeout(hideTimer);
    clearTimeout(statusTimer);
    listeners.forEach(([type, handler]) => video.removeEventListener(type, handler));
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
    document.documentElement.classList.remove("player-active");
    document.title = previousTitle;
    wakeLock?.release?.().catch(() => null);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => null);
    screen.orientation?.unlock?.();
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
    engine.destroy();
    if (playbackId) Backend.releasePlayback(playbackId).catch(() => null);
    clearPendingPlayback();
  };
}
