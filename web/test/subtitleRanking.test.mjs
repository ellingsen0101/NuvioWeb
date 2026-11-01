import assert from "node:assert/strict";
import { test } from "node:test";
import { rankSubtitles, subtitleFitsVideo } from "../src/services/subtitleRanking.js";

const FILE = "Movie.2001.Extended.1080p.BluRay.x264-GROUP.mp4";

test("an exact file hash beats everything", () => {
  const ranked = rankSubtitles(
    [
      { id: "name", title: FILE },
      { id: "hash", title: "unrelated", moviehash: "ABC123" }
    ],
    { filename: FILE, videoHash: "abc123" }
  );
  assert.equal(ranked[0].id, "hash");
});

test("the closest release name comes first", () => {
  const ranked = rankSubtitles(
    [
      { id: "other", title: "Movie.2001.Extended.720p.WEB-DL-OTHERS" },
      { id: "same", title: "Movie.2001.Extended.1080p.BluRay.x264-GROUP" }
    ],
    { filename: FILE }
  );
  assert.equal(ranked[0].id, "same");
});

test("a different cut loses to a less similar name for the right cut", () => {
  const ranked = rankSubtitles(
    [
      { id: "theatrical", title: "Movie.2001.Theatrical.1080p.BluRay.x264-GROUP" },
      { id: "extended", title: "Movie Extended" }
    ],
    { filename: FILE }
  );
  assert.equal(ranked[0].id, "extended");
});

test("AI translations rank below people's work, and trusted uploads above", () => {
  const ranked = rankSubtitles([{ id: "ai", aiTranslated: true }, { id: "plain" }, { id: "trusted", fromTrusted: true }], {});
  assert.deepEqual(ranked.map((option) => option.id), ["trusted", "plain", "ai"]);
});

test("tracks that tie keep the addon's order", () => {
  const ranked = rankSubtitles([{ id: "a" }, { id: "b" }, { id: "c" }], {});
  assert.deepEqual(ranked.map((option) => option.id), ["a", "b", "c"]);
});

test("a track for another cut doesn't fit the video", () => {
  const cuesEndingAt = (end) => [{ start: 0, end }];
  const twoHours = 7200;
  assert.equal(subtitleFitsVideo(cuesEndingAt(6900), twoHours), true, "ends before the credits");
  assert.equal(subtitleFitsVideo(cuesEndingAt(13000), twoHours), false, "runs past the end");
  assert.equal(subtitleFitsVideo(cuesEndingAt(3000), twoHours), false, "stops far too early");
  assert.equal(subtitleFitsVideo(cuesEndingAt(100), 0), true, "unknown duration isn't held against it");
  assert.equal(subtitleFitsVideo([], twoHours), true);
});
