import { subtitleRepository } from "../../../js/data/repository/subtitleRepository.js";
import { getPreferredSubtitleLanguage, matchesLanguage, pickEnglishAudio, sortSubtitlesByLanguage } from "../services/language.js";
import { rankSubtitles, subtitleFitsVideo } from "../services/subtitleRanking.js";
import { watchProgressRepository } from "../../../js/data/repository/watchProgressRepository.js";
import { button, clear, formatDuration, h, icon, iconButton, openSheet, toast } from "../lib/dom.js";
import { goBack, navigate } from "../lib/router.js";
import { Backend, BackendError } from "../services/backend.js";
import { canResolveDebrid, classifyStream, detectCapabilities, streamInfoHash } from "../services/streams.js";
import { DirectDebridResolver } from "../../../js/core/debrid/directDebridResolver.js";
import { clearPendingPlayback, getPendingPlayback, setPendingPlayback } from "../services/playerState.js";
import { createEngine, describeMediaError, usesNativeHls } from "./engine.js";
import { cueAt, loadSubtitleCues } from "./subtitles.js";

const CONTROLS_HIDE_MS = 3500;
const PROGRESS_SAVE_MS = 15000;
const STATUS_POLL_MS = 500;
const SEEK_STEP_S = 10;
// Set by deployments shared with friends. Every web source then streams through the backend, so a
// debrid service sees one address instead of one per viewer, which can look like account sharing.
const STREAM_VIA_BACKEND = /^(1|true|yes)$/i.test(String(globalThis.__NUVIO_ENV__?.NUVIO_STREAM_VIA_BACKEND || ""));
const AUTO_SUBTITLE_ATTEMPTS = 4;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function languageName(code) {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code;
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
  // The addon's stream, or the direct link a debrid provider resolved it to.
  let activeStream = stream;
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
  let forceRemux = false;
  let startedAt = Date.now();
  let startupMs = 0;
  let sourceInfo = null;
  let lastError = "";
  let subtitleChosenByHand = false;
  let fileTrack = null;
  let subtitleStatus = "Looking for subtitles…";
  let statusTimer = 0;
  let pictureTimer = 0;
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
      iconButton("info", "Playback details", () => openDetails()),
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
    lastError = message;
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
      // Copied video starts on the keyframe before the target. Playing from there is much quicker
      // than waiting for the exact position, and the offset keeps the clock and subtitles right.
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

  function showSubtitleText(text) {
    if (subtitleLayer.dataset.text === text) return;
    subtitleLayer.dataset.text = text;
    clear(subtitleLayer);
    if (text) subtitleLayer.append(h("span", { class: "player-sub-line" }, text));
  }

  function renderSubtitle(current) {
    // A track built into the file is timed by the player itself, through cuechange.
    if (fileTrack) return;
    if (!cues.length) {
      showSubtitleText("");
      return;
    }
    showSubtitleText(cueAt(cues, current - subtitleDelayS).map((cue) => cue.text).join("\n"));
  }

  // Subtitle tracks inside the video file, which iOS exposes for MP4s. They're made for exactly this
  // file, so they're preferred when they're in the right language. iOS may also show them on its own,
  // so every one that isn't chosen is turned off.
  function fileTextTracks() {
    return Array.from(video.textTracks || []).filter(
      (track) => track !== nativeTrack && ["subtitles", "captions", "forced"].includes(track.kind)
    );
  }

  function fileTrackOptions() {
    return fileTextTracks().map((track, index) => ({
      fileTrack: track,
      url: `file-track:${index}`,
      label: track.language ? languageName(track.language) : track.label || `Track ${index + 1}`,
      detail: "Built into the video",
      lang: track.language || ""
    }));
  }

  function onFileCueChange() {
    if (!fileTrack) return;
    const text = Array.from(fileTrack.activeCues || [])
      .map((cue) => String(cue.text || "").replace(/<[^>]+>/g, ""))
      .join("\n");
    showSubtitleText(text);
  }

  function releaseFileTrack() {
    if (!fileTrack) return;
    fileTrack.removeEventListener("cuechange", onFileCueChange);
    fileTrack.mode = "disabled";
    fileTrack = null;
  }

  function considerFileTracks() {
    const options = fileTrackOptions();
    fileTextTracks().forEach((track) => {
      if (track !== fileTrack) track.mode = "disabled";
    });
    if (!options.length) return;
    subtitleOptions = [...options, ...subtitleOptions.filter((option) => !option.fileTrack)];
    const preferred = getPreferredSubtitleLanguage();
    const match = preferred !== "off" && options.find((option) => matchesLanguage(option, preferred));
    if (match && !subtitleChosenByHand && !fileTrack) applySubtitle(match, []);
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

  function applySubtitle(option, loaded) {
    releaseFileTrack();
    cues = option?.fileTrack ? [] : loaded;
    selectedSubtitle = option;
    subtitleLayer.dataset.text = "";
    if (option?.fileTrack) {
      fileTrack = option.fileTrack;
      fileTrack.mode = video.webkitDisplayingFullscreen ? "showing" : "hidden";
      fileTrack.addEventListener("cuechange", onFileCueChange);
      onFileCueChange();
    }
    syncNativeTrack();
    renderTimeline();
  }

  // The length check needs the video's duration, which arrives after the source has started.
  async function waitForDuration(timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (!disposed && !duration() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return duration();
  }

  // Tries the best-ranked tracks in turn, skipping any that fail to load or are clearly for another
  // cut. A choice made by hand in the player is never second-guessed.
  async function autoSelectSubtitle(candidates) {
    let fallback = null;
    for (const option of candidates.slice(0, AUTO_SUBTITLE_ATTEMPTS)) {
      if (disposed || subtitleChosenByHand) return;
      let loaded;
      try {
        loaded = await loadSubtitleCues(option.url, { signal: controller.signal });
      } catch (error) {
        if (error?.name === "AbortError") return;
        continue;
      }
      if (disposed || subtitleChosenByHand || fileTrack) return;
      fallback ||= { option, loaded };
      if (!selectedSubtitle) applySubtitle(option, loaded);
      if (subtitleFitsVideo(loaded, await waitForDuration())) {
        if (!disposed && !subtitleChosenByHand) applySubtitle(option, loaded);
        return;
      }
    }
    if (fallback && !disposed && !subtitleChosenByHand && !fileTrack) applySubtitle(fallback.option, fallback.loaded);
    if (!fallback) subtitleStatus = "None of the best matches would load";
  }

  async function selectSubtitle(option) {
    subtitleChosenByHand = true;
    if (!option?.url) {
      releaseFileTrack();
      selectedSubtitle = null;
      cues = [];
      syncNativeTrack();
      renderTimeline();
      return;
    }
    if (option.fileTrack) {
      applySubtitle(option, []);
      return;
    }
    try {
      statusText.textContent = "Loading subtitles…";
      applySubtitle(option, await loadSubtitleCues(option.url, { signal: controller.signal }));
    } catch (error) {
      if (error?.name !== "AbortError") {
        lastError = `Subtitles: ${error?.message || "unknown error"}`;
        toast(`Subtitles couldn't load: ${error?.message || "unknown error"}`, { error: true });
      }
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
    // Built-in subtitles are timed by the player, so only addon subtitles can be shifted.
    const delayControls = fileTrack
      ? h("p", { class: "muted delay-row" }, "These subtitles are built into the video, so they're timed for it.")
      : h(
          "div",
          { class: "delay-row" },
          h("span", {}, "Timing"),
          iconButton("remove", "Show subtitles earlier", () => adjust(-0.5)),
          delayLabel,
          iconButton("add", "Show subtitles later", () => adjust(0.5))
        );
    const sameLanguage = subtitleOptions.filter((option) => !option.fileTrack && matchesLanguage(option, selectedSubtitle?.lang ? String(selectedSubtitle.lang).slice(0, 2).toLowerCase() : "en"));
    const next = selectedSubtitle && !fileTrack ? sameLanguage[sameLanguage.findIndex((option) => option.url === selectedSubtitle.url) + 1] : null;
    const nextMatch = next
      ? button("Out of sync? Try the next best match", () => {
          document.querySelector(".player-root .sheet-backdrop")?.remove();
          document.documentElement.classList.remove("sheet-open");
          selectSubtitle(next);
        }, { kind: "secondary", iconName: "swap_horiz" })
      : null;
    picker(
      "Subtitles",
      [
        { label: "Off", active: !selectedSubtitle },
        ...subtitleOptions.map((option) => ({ ...option, active: selectedSubtitle?.url === option.url }))
      ],
      selectSubtitle,
      h("div", { class: "stack" }, delayControls, nextMatch)
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

  // iPhones play the audio of a video they can't decode and show a black picture, with no error.
  function checkForMissingPicture() {
    clearTimeout(pictureTimer);
    pictureTimer = setTimeout(() => {
      if (disposed || video.paused || video.videoWidth > 0) return;
      if (Backend.isConnected() && !forceRemux && /^https?:/i.test(activeStream.url || "")) {
        pendingResumeS = position();
        forceRemux = true;
        triedBackendFallback = true;
        const previous = playbackId;
        playbackId = null;
        if (previous) Backend.releasePlayback(previous).catch(() => null);
        video.pause();
        setBuffering(true, "This device can't show this video's picture. Converting it…");
        startSource();
        return;
      }
      showError("This device plays the sound of this source but can't show its picture. Try another source.");
    }, 1500);
  }

  function openDetails() {
    const rows = [
      ["Delivery", isBackendHls ? "Converted by server (HLS)" : playbackId ? "Through server, not converted" : "Direct from source"],
      ["Video size", video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : "No picture"],
      ["Codec", sourceInfo ? `${sourceInfo.videoCodec}${sourceInfo.videoTag ? ` (${sourceInfo.videoTag})` : ""}` : "Not checked"],
      ["Container", sourceInfo?.container || "Not checked"],
      ["Time to start", startupMs ? `${(startupMs / 1000).toFixed(1)} s` : "Not started"],
      ["Timeline offset", `${timeOffset.toFixed(1)} s`],
      ["Subtitles", selectedSubtitle ? (fileTrack ? `${selectedSubtitle.label}, built into the video` : `${selectedSubtitle.label}, ${cues.length} lines, ${subtitleDelayS.toFixed(1)} s timing`) : subtitleStatus],
      ["Tracks built into the video", String(fileTextTracks().length)],
      ["Subtitle release", selectedSubtitle?.title || selectedSubtitle?.detail || "Unknown"],
      ["Exact file match", selectedSubtitle ? (selectedSubtitle.moviehash && stream.behaviorHints?.videoHash && String(selectedSubtitle.moviehash).toLowerCase() === String(stream.behaviorHints.videoHash).toLowerCase() ? "Yes" : "No") : "Not applicable"],
      ["Last subtitle line", cues.length ? `${formatDuration(cues[cues.length - 1].end * 1000)} of ${formatDuration(duration() * 1000)}` : "None"],
      ["Subtitle tracks found", String(subtitleOptions.length)],
      ["Last error", lastError || "None"]
    ];
    openSheet({
      title: "Playback details",
      className: "sheet-player",
      content: h("dl", { class: "details-list" }, rows.map(([term, value]) => [h("dt", {}, term), h("dd", {}, value)]))
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
    startedAt = Date.now();
    startupMs = 0;
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
    const requestedStart = pendingResumeS || 0;
    const body = {
      capabilities,
      startAt: requestedStart,
      forceRemux,
      preferredAudio: "en"
    };
    const infoHash = streamInfoHash(activeStream);
    const created = infoHash
      ? await Backend.createTorrentPlayback(
          {
            ...body,
            infoHash,
            sources: activeStream.sources || [],
            fileIdx: activeStream.fileIdx ?? null,
            filename: activeStream.behaviorHints?.filename || null,
            season: episode?.season ?? null,
            episode: episode?.episode ?? null
          },
          { signal: controller.signal }
        )
      : await Backend.createUrlPlayback(
          { ...body, url: activeStream.url, headers: activeStream.behaviorHints?.proxyHeaders?.request || null },
          { signal: controller.signal }
        );
    playbackId = created.id;
    const ready = await pollTorrent(created.id);
    if (!ready || disposed) return;
    knownDuration = Number(ready.duration || 0);
    isBackendHls = ready.mode === "hls";
    backendAudio = ready.audioTracks || [];
    sourceInfo = ready.info || null;
    timeOffset = isBackendHls ? Number(ready.startOffset || 0) : 0;
    if (isBackendHls) pendingResumeS = 0;
    audioIndex = ready.audioIndex ?? null;
    const playingAudio = backendAudio.find((track) => track.index === audioIndex);
    if (playingAudio?.language && !matchesLanguage(playingAudio, "en")) {
      toast(`This source has no English audio. Playing ${languageName(playingAudio.language)}.`);
    }
    if (ready.mode === "direct" && ready.sourceUrl && !STREAM_VIA_BACKEND) {
      // Nothing to convert, so the video doesn't need to pass through the backend.
      const finished = playbackId;
      playbackId = null;
      Backend.releasePlayback(finished).catch(() => null);
      await engine.load({ url: ready.sourceUrl, kind: "direct" });
      return;
    }
    await engine.load({ url: ready.url, kind: ready.mode === "hls" ? "hls" : "direct" });
  }

  async function startSource() {
    if (disposed) return;
    setBuffering(true, "Loading…");
    errorBox.hidden = true;
    try {
      const position = { season: episode?.season ?? null, episode: episode?.episode ?? null };
      if (canResolveDebrid(activeStream, position)) {
        setBuffering(true, "Getting the link from your debrid service…");
        const resolved = await DirectDebridResolver.resolve(activeStream, position);
        if (disposed) return;
        if (resolved?.status === "success" && resolved.stream?.url) activeStream = resolved.stream;
        else if (!Backend.isConnected() || !streamInfoHash(activeStream)) {
          showError(resolved?.message || "Your debrid service couldn't provide this source.");
          return;
        }
      }
      const sourceKind = classifyStream(activeStream, position);
      // Apple's players show no picture for some MP4s and give no error. A quick check by the backend
      // avoids a black screen, and playback still goes straight to the source when the file is fine.
      const checkFirst = usesNativeHls(video) && Backend.isConnected() && (sourceKind === "direct" || sourceKind === "unknown");
      // HLS sources stay direct: the backend can't proxy a playlist's segments, and they rarely come from debrid.
      const routed = STREAM_VIA_BACKEND && Backend.isConnected() && /^https?:/i.test(activeStream.url || "") && sourceKind !== "hls";
      const needsBackend = sourceKind === "torrent" || sourceKind === "server" || triedBackendFallback || checkFirst || routed;
      if (needsBackend) {
        if (!Backend.isConnected()) {
          showError("This source needs your streaming backend. Connect it in Settings, then try again.", { retry: false });
          return;
        }
        await startBackendPlayback();
      } else {
        await engine.load({ url: activeStream.url, kind: sourceKind === "hls" ? "hls" : "direct" });
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
        detail: entry.title || entry.addonName || "",
        lang: entry.lang,
        title: entry.title,
        moviehash: entry.moviehash,
        fromTrusted: entry.fromTrusted,
        aiTranslated: entry.aiTranslated
      }))
    ];
    const preferred = getPreferredSubtitleLanguage();
    const language = preferred === "off" ? "en" : preferred;
    const file = { filename: stream.behaviorHints?.filename, videoHash: stream.behaviorHints?.videoHash };
    subtitleOptions = sortSubtitlesByLanguage(rankSubtitles(subtitleOptions, file), language);
    subtitleOptions = [...fileTrackOptions(), ...subtitleOptions];
    if (!subtitleOptions.some((option) => matchesLanguage(option, language))) subtitleStatus = `No ${languageName(language)} subtitles found`;
    if (preferred !== "off" && !subtitleChosenByHand && !fileTrack) {
      autoSelectSubtitle(subtitleOptions.filter((option) => matchesLanguage(option, language)));
    }
  }

  // Events
  const listeners = [
    ["loadedmetadata", () => {
      considerFileTracks();
      // A file with several audio tracks, played directly by the browser, starts on its first one.
      const english = !isBackendHls && pickEnglishAudio(engine.audioTracks());
      if (english && !english.active) engine.selectAudio(english.id);
      if (pendingResumeS > 0.5) {
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
      if (!startupMs) startupMs = Date.now() - startedAt;
      checkForMissingPicture();
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
      if ((code === 4 || code === 3) && !triedBackendFallback && !playbackId && Backend.isConnected() && /^https?:/i.test(activeStream.url || "")) {
        triedBackendFallback = true;
        forceRemux = true;
        pendingResumeS = position() || pendingResumeS;
        setBuffering(true, "Converting for this device…");
        startSource();
        return;
      }
      showError(describeMediaError(video, { backendConnected: Backend.isConnected(), viaBackend: Boolean(playbackId) }));
    }],
    ["webkitbeginfullscreen", () => {
      if (fileTrack) fileTrack.mode = "showing";
      else if (nativeTrack) nativeTrack.mode = "showing";
    }],
    ["webkitendfullscreen", () => {
      if (fileTrack) fileTrack.mode = "hidden";
      if (nativeTrack) nativeTrack.mode = "hidden";
    }]
  ];
  listeners.forEach(([type, handler]) => video.addEventListener(type, handler));
  // iOS adds an MP4's own text tracks as it reads the file, sometimes after metadata.
  const onTrackAdded = () => considerFileTracks();
  video.textTracks?.addEventListener?.("addtrack", onTrackAdded);

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

  const onPageHide = (event) => {
    saveProgress(true);
    if (!event.persisted && playbackId) Backend.releasePlaybackOnExit(playbackId);
  };
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
  const previousTitle = document.title;
  document.title = `${title} · Nuvio`;

  return () => {
    disposed = true;
    saveProgress(true);
    controller.abort();
    clearTimeout(hideTimer);
    clearTimeout(statusTimer);
    clearTimeout(pictureTimer);
    listeners.forEach(([type, handler]) => video.removeEventListener(type, handler));
    video.textTracks?.removeEventListener?.("addtrack", onTrackAdded);
    releaseFileTrack();
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
