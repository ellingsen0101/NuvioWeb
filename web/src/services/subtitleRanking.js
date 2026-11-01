// Picks the subtitle most likely to be timed for the file being played. A track made for another
// release or cut can be seconds off, or drift further the later you are in the film.
const IGNORED_TOKENS = new Set(["mp4", "mkv", "avi", "srt", "sub", "the", "and", "of", "a", "x264", "x265", "h264", "h265", "hevc", "avc", "aac", "ac3", "dts", "ddp", "dd", "eac3", "atmos"]);
const EDITION_TOKENS = ["extended", "theatrical", "directors", "unrated", "remastered"];

function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/director'?s/g, "directors")
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !IGNORED_TOKENS.has(token));
}

function score(option, { filename, videoHash }) {
  let total = 0;
  if (videoHash && option.moviehash && String(option.moviehash).toLowerCase() === String(videoHash).toLowerCase()) total += 1000;
  if (filename && option.title) {
    const fileTokens = new Set(tokens(filename));
    const titleTokens = new Set(tokens(option.title));
    const shared = [...titleTokens].filter((token) => fileTokens.has(token)).length;
    const union = new Set([...fileTokens, ...titleTokens]).size;
    total += union ? (shared / union) * 100 : 0;
    // Different cuts can't line up, however similar the rest of the name is.
    for (const edition of EDITION_TOKENS) {
      if (fileTokens.has(edition) !== titleTokens.has(edition)) total -= 40;
    }
  }
  if (option.fromTrusted) total += 5;
  if (option.aiTranslated) total -= 30;
  return total;
}

// Stable, so equal tracks keep the order the addons returned.
export function rankSubtitles(options, video = {}) {
  return options
    .map((option, index) => ({ option, index, value: score(option, video) }))
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .map((entry) => entry.option);
}

// Credits run past the last line, but a track much shorter, or longer than the video, is another cut.
export function subtitleFitsVideo(cues, durationSeconds) {
  if (!cues?.length || !(durationSeconds > 0)) return true;
  const lastLine = cues[cues.length - 1].end;
  return lastLine <= durationSeconds + 30 && lastLine >= durationSeconds * 0.75;
}
