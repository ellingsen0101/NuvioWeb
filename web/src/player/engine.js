// Loads a source into the <video> element. Apple devices play HLS natively (and iPhone Safari has no
// standard MSE). Everything else uses hls.js: recent Chromium browsers also report native HLS through
// canPlayType, but their parser rejects streams that hls.js plays fine.
export function usesNativeHls(video, userAgent = navigator.userAgent) {
  if (!video.canPlayType("application/vnd.apple.mpegurl")) return false;
  const isIos = /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1);
  const isDesktopSafari = /Safari\//.test(userAgent) && !/Chrome|Chromium|Edg|OPR|Android/.test(userAgent);
  return isIos || isDesktopSafari;
}

export function describeMediaError(video, { backendConnected = false, viaBackend = false } = {}) {
  const code = video?.error?.code;
  if (code === 4) {
    if (viaBackend) return "This device couldn't play the converted video. Try another source.";
    return backendConnected
      ? "This browser can't play this video format. Try another source."
      : "This browser can't play this video format. Try another source, or connect your streaming backend so it can be converted.";
  }
  if (code === 3) return "The video data couldn't be decoded. It may use a codec this device doesn't support.";
  if (code === 2) return "The video stopped loading because of a network problem.";
  if (code === 1) return "Playback was interrupted.";
  return "This video couldn't be played.";
}

export function createEngine(video, { onFatal, onTracks }) {
  let hls = null;

  function destroyHls() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
  }

  async function load({ url, kind }) {
    destroyHls();
    if (kind !== "hls") {
      video.src = url;
      video.load();
      return;
    }
    if (usesNativeHls(video)) {
      video.src = url;
      video.load();
      return;
    }
    const { default: Hls } = await import("./hls-engine.js");
    if (!Hls.isSupported()) {
      if (!video.canPlayType("application/vnd.apple.mpegurl")) throw new Error("This browser can't play HLS streams.");
      video.src = url;
      video.load();
      return;
    }
    hls = new Hls({
      enableWorker: true,
      startPosition: 0,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      backBufferLength: 30,
      manifestLoadingMaxRetry: 6,
      levelLoadingMaxRetry: 6,
      fragLoadingMaxRetry: 6
    });
    let mediaRecoveries = 0;
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        onFatal?.("The stream stopped loading because of a network problem.");
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
        mediaRecoveries += 1;
        hls.recoverMediaError();
      } else {
        onFatal?.("This stream couldn't be decoded on this device.");
      }
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => onTracks?.());
    hls.on(Hls.Events.MANIFEST_PARSED, () => onTracks?.());
    hls.loadSource(url);
    hls.attachMedia(video);
  }

  function audioTracks() {
    if (hls) {
      return hls.audioTracks.map((track, index) => ({
        id: index,
        label: track.name || track.lang || `Track ${index + 1}`,
        language: track.lang || "",
        active: hls.audioTrack === index
      }));
    }
    const native = video.audioTracks;
    if (!native?.length) return [];
    return Array.from({ length: native.length }, (_, index) => ({
      id: index,
      label: native[index].label || native[index].language || `Track ${index + 1}`,
      language: native[index].language || "",
      active: native[index].enabled
    }));
  }

  function selectAudio(id) {
    if (hls) {
      hls.audioTrack = id;
      return;
    }
    const native = video.audioTracks;
    if (!native) return;
    for (let index = 0; index < native.length; index += 1) native[index].enabled = index === id;
  }

  function destroy() {
    destroyHls();
    video.pause();
    video.removeAttribute("src");
    video.load();
  }

  return { load, audioTracks, selectAudio, destroy };
}
