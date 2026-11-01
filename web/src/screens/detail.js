import { metaRepository } from "../../../js/data/repository/metaRepository.js";
import { streamRepository } from "../../../js/data/repository/streamRepository.js";
import { savedLibraryRepository } from "../../../js/data/repository/savedLibraryRepository.js";
import { watchProgressRepository } from "../../../js/data/repository/watchProgressRepository.js";
import { watchedItemsRepository } from "../../../js/data/repository/watchedItemsRepository.js";
import { getWatchProgressFraction } from "../../../js/domain/model/watchProgress.js";
import { WatchProgressStore } from "../../../js/data/local/watchProgressStore.js";
import { ProfileManager } from "../../../js/core/profile/profileManager.js";
import { button, clear, emptyState, formatDuration, h, icon, iconButton, image, openSheet, safeImageUrl, safeLinkUrl, spinner, toast } from "../lib/dom.js";
import { goBack, navigate } from "../lib/router.js";
import { Backend } from "../services/backend.js";
import { classifyStream, streamKindLabel, streamText } from "../services/streams.js";
import { setPendingPlayback } from "../services/playerState.js";

function normalizeEpisodes(meta) {
  return (meta.videos || [])
    .map((video) => ({
      ...video,
      season: Number(video.season ?? 0),
      episode: Number(video.episode ?? video.number ?? 0),
      title: video.name || video.title || ""
    }))
    .filter((video) => video.id)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function isSeries(meta, episodes) {
  return meta.type === "series" || meta.type === "anime" || (episodes.length > 0 && episodes.some((video) => video.season > 0 || video.episode > 0));
}

function progressList(contentId) {
  const profileId = String(ProfileManager.getActiveProfileId() || "1");
  return WatchProgressStore.listForProfile(profileId).filter((item) => item.contentId === contentId);
}

function streamRow(stream, onPick) {
  const kind = classifyStream(stream);
  const { name, description } = streamText(stream);
  const blocked =
    kind === "unsupported" ||
    ((kind === "torrent" || kind === "server") && !Backend.isConnected());
  return h(
    "button",
    {
      type: "button",
      class: `stream-row ${blocked ? "is-blocked" : ""}`,
      onClick: () => onPick(stream, kind, blocked)
    },
    h(
      "span",
      { class: "stream-main" },
      h("strong", { class: "stream-name" }, name),
      description ? h("span", { class: "stream-desc" }, description) : null
    ),
    h("span", { class: `stream-kind stream-kind-${kind}` }, streamKindLabel(kind)),
    icon(kind === "external" || kind === "youtube" ? "open_in_new" : "play_arrow", { filled: true })
  );
}

function openStreamsSheet({ meta, video, onPick }) {
  const controller = new AbortController();
  const list = h("div", { class: "stream-list" });
  const footer = h("div", { class: "center-pad" }, spinner("Finding sources"));
  const groups = new Map();

  const sheet = openSheet({
    title: video ? `S${video.season} E${video.episode}${video.title ? ` · ${video.title}` : ""}` : meta.name,
    className: "sheet-streams",
    onClose: () => controller.abort(),
    content: h(
      "div",
      {},
      !Backend.isConnected()
        ? h("p", { class: "notice" }, "Torrent sources and formats the browser can't play need your streaming backend. Connect it in Settings.")
        : null,
      list,
      footer
    )
  });

  const renderGroup = (group) => {
    const key = group.addonBaseUrl || group.addonName || group.name;
    let section = groups.get(key);
    if (!section) {
      section = h("section", { class: "stream-group" });
      groups.set(key, section);
      list.append(section);
    }
    section.replaceChildren(
      h("h3", {}, group.addonName || group.name || "Sources"),
      ...group.streams.map((stream) =>
        streamRow(stream, (picked, kind, blocked) => {
          if (blocked) {
            toast(kind === "unsupported" ? "This source can't be played here." : "Connect your streaming backend in Settings to use this source.", { error: true });
            return;
          }
          sheet.close();
          onPick(picked, kind, group.streams);
        })
      )
    );
  };

  const type = meta.type === "anime" ? "series" : meta.type;
  const videoId = video?.id || meta.id;
  streamRepository
    .getStreamsFromAllAddons(type, videoId, {
      signal: controller.signal,
      season: video?.season ?? null,
      episode: video?.episode ?? null,
      onChunk: (chunk) => (chunk?.data || []).forEach(renderGroup)
    })
    .then((result) => {
      if (controller.signal.aborted) return;
      (result?.data || []).forEach(renderGroup);
      clear(footer);
      if (!groups.size) {
        footer.append(
          emptyState({
            iconName: "search_off",
            title: "No sources found",
            detail: "None of your addons returned a stream for this title. Add a stream addon in Settings."
          })
        );
      }
    })
    .catch((error) => {
      if (error?.name === "AbortError") return;
      clear(footer).append(emptyState({ iconName: "cloud_off", title: "Sources couldn't load", detail: error?.message || "" }));
    });
}

function episodeRow({ video, progress, onPlay, onToggleWatched, watched }) {
  const fraction = progress ? getWatchProgressFraction(progress) : 0;
  const finished = watched || fraction >= 0.9;
  return h(
    "div",
    { class: `episode ${finished ? "is-watched" : ""}` },
    h(
      "button",
      { type: "button", class: "episode-main", onClick: onPlay },
      h(
        "span",
        { class: "episode-thumb" },
        image(video.thumbnail, { alt: "" }),
        h("span", { class: "episode-number" }, video.episode),
        fraction > 0 && !finished
          ? h("span", { class: "continue-bar" }, h("span", { style: { width: `${Math.round(fraction * 100)}%` } }))
          : null
      ),
      h(
        "span",
        { class: "episode-text" },
        h("strong", {}, video.title || `Episode ${video.episode}`),
        video.released ? h("small", {}, new Date(video.released).toLocaleDateString()) : null,
        video.overview || video.description ? h("span", { class: "episode-desc" }, video.overview || video.description) : null
      )
    ),
    iconButton(finished ? "check_circle" : "radio_button_unchecked", finished ? "Mark as unwatched" : "Mark as watched", onToggleWatched, {
      className: "episode-check",
      filled: finished
    })
  );
}

export function mountDetail(node, route) {
  const [type, id] = route.segments;
  const addonBaseUrl = route.query.addon || null;
  let disposed = false;

  const backButton = iconButton("arrow_back", "Back", () => goBack(), { className: "detail-back" });
  const body = h("div", { class: "detail-body" }, h("div", { class: "center-pad" }, spinner()));
  const backdrop = h("div", { class: "detail-backdrop" });
  node.append(backButton, backdrop, body);

  function startPlayback(meta, video, stream, kind, resumeMs) {
    if (kind === "external" || kind === "youtube") {
      const url = stream.ytId ? `https://www.youtube.com/watch?v=${encodeURIComponent(stream.ytId)}` : safeLinkUrl(stream.externalUrl);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      else toast("This link can't be opened", { error: true });
      return;
    }
    setPendingPlayback({ meta, video, stream, kind, resumeMs, episodes: normalizeEpisodes(meta) });
    navigate("player", [meta.type || type, meta.id]);
  }

  function pickSource(meta, video) {
    const contentProgress = progressList(meta.id).find((item) =>
      video ? item.videoId === video.id : !item.videoId
    );
    const resumeMs = contentProgress && getWatchProgressFraction(contentProgress) < 0.9 ? contentProgress.positionMs : 0;
    openStreamsSheet({
      meta,
      video,
      onPick: (stream, kind) => startPlayback(meta, video, stream, kind, resumeMs)
    });
  }

  async function renderEpisodes(container, meta, episodes, initialVideoId) {
    const seasons = [...new Set(episodes.map((video) => video.season))].sort((a, b) => (a === 0) - (b === 0) || a - b);
    const initial = episodes.find((video) => video.id === initialVideoId);
    let season = initial?.season ?? seasons.find((value) => value > 0) ?? seasons[0];
    const chips = h("div", { class: "chips chips-scroll season-chips" });
    const list = h("div", { class: "episode-list" });

    async function renderSeason() {
      chips.replaceChildren(
        ...seasons.map((value) =>
          h(
            "button",
            {
              type: "button",
              class: `chip chip-toggle ${value === season ? "is-active" : ""}`,
              onClick: () => {
                season = value;
                renderSeason();
              }
            },
            value === 0 ? "Specials" : `Season ${value}`
          )
        )
      );
      const progress = progressList(meta.id);
      const seasonEpisodes = episodes.filter((video) => video.season === season);
      const watchedStates = await Promise.all(
        seasonEpisodes.map((video) =>
          watchedItemsRepository
            .isWatched(meta.id, { contentType: "series", season: video.season, episode: video.episode, videoId: video.id })
            .catch(() => false)
        )
      );
      if (disposed) return;
      list.replaceChildren(
        ...seasonEpisodes.map((video, index) =>
          episodeRow({
            video,
            watched: watchedStates[index],
            progress: progress.find((item) => item.videoId === video.id),
            onPlay: () => pickSource(meta, video),
            onToggleWatched: async () => {
              const details = { contentType: "series", season: video.season, episode: video.episode, videoId: video.id };
              if (watchedStates[index]) {
                await watchedItemsRepository.unmark(meta.id, details);
                await watchProgressRepository.removeProgress(meta.id, video.id);
              } else {
                await watchedItemsRepository.mark({ contentId: meta.id, title: meta.name, released: video.released, watchedAt: Date.now(), ...details });
                await watchProgressRepository.saveProgress({ contentId: meta.id, ...details, positionMs: 100, durationMs: 100, updatedAt: Date.now() });
              }
              renderSeason();
            }
          })
        )
      );
    }

    clear(container).append(h("h2", { class: "section-title" }, "Episodes"), chips, list);
    await renderSeason();
    return { nextUp: () => null };
  }

  async function render(meta) {
    const episodes = normalizeEpisodes(meta);
    const series = isSeries(meta, episodes);
    const contentProgress = progressList(meta.id);
    const latest = [...contentProgress].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const resumable = latest && getWatchProgressFraction(latest) < 0.9 ? latest : null;
    const resumeEpisode = series && resumable ? episodes.find((video) => video.id === resumable.videoId) : null;
    const firstEpisode = episodes.find((video) => video.season > 0) || episodes[0];
    const playTarget = series ? resumeEpisode || firstEpisode : null;

    const art = meta.background || meta.poster;
    if (safeImageUrl(art)) backdrop.replaceChildren(image(art, { alt: "", eager: true }));

    const saveButton = h("button", { type: "button", class: "btn btn-secondary" });
    const libraryItem = {
      contentId: meta.id,
      contentType: meta.type,
      title: meta.name,
      id: meta.id,
      type: meta.type,
      name: meta.name,
      poster: meta.poster,
      background: meta.background,
      logo: meta.logo,
      description: meta.description,
      releaseInfo: meta.releaseInfo
    };
    const renderSave = async () => {
      const saved = await savedLibraryRepository.isSaved(meta.id).catch(() => false);
      saveButton.replaceChildren(icon(saved ? "bookmark_added" : "bookmark_add", { filled: saved }), h("span", {}, saved ? "In Library" : "Save"));
    };
    saveButton.addEventListener("click", async () => {
      await savedLibraryRepository.toggle(libraryItem);
      renderSave();
    });
    renderSave();

    const playLabel = resumable
      ? `Resume${resumeEpisode ? ` S${resumeEpisode.season} E${resumeEpisode.episode}` : ""} · ${formatDuration(resumable.positionMs)}`
      : series && playTarget
        ? `Play S${playTarget.season} E${playTarget.episode}`
        : "Play";

    const facts = [meta.releaseInfo, meta.runtime, meta.ageRating, meta.imdbRating ? `IMDb ${meta.imdbRating}` : null].filter(Boolean);
    const cast = (meta.cast || meta.credits_cast || []).slice?.(0, 12) || [];
    const episodesSlot = h("div", {});
    const logo = safeImageUrl(meta.logo);

    clear(body).append(
      h(
        "div",
        { class: "detail-head" },
        safeImageUrl(meta.poster) ? h("div", { class: "detail-poster" }, image(meta.poster, { alt: "", eager: true })) : null,
        h(
          "div",
          { class: "detail-info" },
          logo
            ? h("img", { class: "detail-logo", src: logo, alt: meta.name, referrerPolicy: "no-referrer" })
            : h("h1", { class: "detail-title" }, meta.name),
          facts.length ? h("p", { class: "detail-facts" }, facts.join("  ·  ")) : null,
          h(
            "div",
            { class: "detail-actions" },
            button(playLabel, () => pickSource(meta, playTarget), { kind: "primary", iconName: "play_arrow" }),
            saveButton
          ),
          meta.genres?.length ? h("div", { class: "chips" }, meta.genres.slice(0, 5).map((genre) => h("span", { class: "chip" }, genre))) : null,
          meta.description ? h("p", { class: "detail-desc" }, meta.description) : null,
          cast.length ? h("p", { class: "detail-cast" }, h("strong", {}, "Cast  "), cast.map((entry) => entry?.name || entry).join(", ")) : null,
          meta.director?.length ? h("p", { class: "detail-cast" }, h("strong", {}, "Director  "), [].concat(meta.director).join(", ")) : null
        )
      ),
      series ? episodesSlot : null
    );

    if (series && episodes.length) await renderEpisodes(episodesSlot, meta, episodes, route.query.video || resumable?.videoId);
    if (route.query.play) {
      const video = episodes.find((entry) => entry.id === route.query.video) || (series ? playTarget : null);
      pickSource(meta, video);
    }
  }

  (async () => {
    let result = await metaRepository.getMetaFromAllAddons(type, id, null);
    if (disposed) return;
    if (result.status !== "success" && addonBaseUrl) {
      result = await metaRepository.getMeta(addonBaseUrl, type, id);
    }
    if (disposed) return;
    if (result.status !== "success" || !result.data) {
      clear(body).append(
        emptyState({
          iconName: "movie",
          title: "This title couldn't load",
          detail: "None of your addons returned details for it.",
          action: button("Go back", () => goBack(), { kind: "primary" })
        })
      );
      return;
    }
    await render({ ...result.data, type: result.data.type || type });
  })().catch((error) => {
    console.error("Detail failed", error);
    if (!disposed) clear(body).append(emptyState({ iconName: "error", title: "Something went wrong", detail: error?.message || "" }));
  });

  return () => {
    disposed = true;
  };
}
