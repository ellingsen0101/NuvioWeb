import { buildOrderedHomeCatalogItems, catalogSkipStep, toDisplayTypeLabel } from "../../../js/core/addons/homeCatalogs.js";
import { StartupSyncService } from "../../../js/core/profile/startupSyncService.js";
import { HomeCatalogStore } from "../../../js/data/local/homeCatalogStore.js";
import { addonRepository } from "../../../js/data/repository/addonRepository.js";
import { loadInstalledAddons } from "../services/addons.js";
import { catalogRepository } from "../../../js/data/repository/catalogRepository.js";
import { watchProgressRepository } from "../../../js/data/repository/watchProgressRepository.js";
import { getWatchProgressFraction } from "../../../js/domain/model/watchProgress.js";
import { button, clear, emptyState, fill, h, icon, image, safeImageUrl, spinner, toast } from "../lib/dom.js";
import { hrefFor, navigate } from "../lib/router.js";
import { continueCard, detailHref, posterCard, row, skeletonRow } from "../components/cards.js";

const HERO_INTERVAL_MS = 8000;
const HERO_ITEMS = 6;

function heroCatalog(entries) {
  return entries.find((entry) => !entry.isDisabled) || null;
}

function renderHero(container, items) {
  const candidates = items.filter((item) => safeImageUrl(item.background || item.poster)).slice(0, HERO_ITEMS);
  if (!candidates.length) return () => {};
  let index = 0;
  let timer = 0;
  const backdrop = h("div", { class: "hero-backdrop" });
  const content = h("div", { class: "hero-content" });
  const dots = h("div", { class: "hero-dots" });

  function show(next) {
    index = (next + candidates.length) % candidates.length;
    const item = candidates[index];
    // The previous artwork stays up until the next has loaded, so rotating never flashes black.
    const art = image(item.background || item.poster, { alt: "", eager: true });
    art.addEventListener(
      "load",
      () => {
        [...backdrop.children].forEach((node) => {
          if (node !== art) setTimeout(() => node.remove(), 700);
        });
      },
      { once: true }
    );
    backdrop.append(art);
    const logo = safeImageUrl(item.logo);
    fill(content,
      logo
        ? h("img", { class: "hero-logo", src: logo, alt: item.name, referrerPolicy: "no-referrer" })
        : h("h1", { class: "hero-title" }, item.name),
      h(
        "p",
        { class: "hero-meta" },
        [item.releaseInfo, item.runtime, ...(item.genres || []).slice(0, 2)].filter(Boolean).join("  ·  ")
      ),
      item.description ? h("p", { class: "hero-desc" }, item.description) : null,
      h(
        "div",
        { class: "hero-actions" },
        h("a", { class: "btn btn-primary", href: detailHref(item) }, icon("info"), h("span", {}, "View details"))
      )
    );
    dots.replaceChildren(
      ...candidates.map((_, dotIndex) =>
        h("button", {
          type: "button",
          class: `hero-dot ${dotIndex === index ? "is-active" : ""}`,
          "aria-label": `Show item ${dotIndex + 1}`,
          onClick: () => {
            show(dotIndex);
            schedule();
          }
        })
      )
    );
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState === "visible" && !container.closest("[hidden]")) show(index + 1);
    }, HERO_INTERVAL_MS);
  }

  let touchX = null;
  container.addEventListener("touchstart", (event) => { touchX = event.touches[0].clientX; }, { passive: true });
  container.addEventListener(
    "touchend",
    (event) => {
      if (touchX == null) return;
      const delta = event.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(delta) > 48) {
        show(index + (delta < 0 ? 1 : -1));
        schedule();
      }
    },
    { passive: true }
  );

  clear(container).append(backdrop, h("div", { class: "hero-scrim" }), content, candidates.length > 1 ? dots : "");
  show(0);
  schedule();
  return () => clearInterval(timer);
}

function episodeLabel(progress) {
  if (progress.season != null && progress.episode != null) {
    return `S${progress.season} E${progress.episode}`;
  }
  return "";
}

async function renderContinueWatching(slot) {
  const items = await watchProgressRepository.getRecent(20).catch(() => []);
  const visible = items.filter((item) => {
    const fraction = getWatchProgressFraction(item);
    return fraction < 0.9 && item.contentId;
  });
  if (!visible.length) {
    clear(slot);
    return;
  }
  clear(slot).append(
    row({
      title: "Continue Watching",
      className: "row-continue",
      items: visible.map((item) => {
        const meta = item.enrichedMeta || {};
        const title = meta.name || item.title || item.name || "Untitled";
        const seriesVideo = item.videoId && item.season != null;
        return continueCard({
          title,
          subtitle: [episodeLabel(item), item.episodeTitle].filter(Boolean).join(" · "),
          art: item.backdrop || item.background || meta.background || item.poster || meta.poster,
          fraction: getWatchProgressFraction(item),
          href: hrefFor("detail", [item.contentType || "movie", item.contentId], {
            play: 1,
            video: seriesVideo ? item.videoId : null
          }),
          onRemove: async (event) => {
            event.preventDefault();
            await watchProgressRepository.removeProgress(item.contentId, item.videoId).catch(() => null);
            renderContinueWatching(slot);
          }
        });
      })
    })
  );
}

function renderCatalogRow(slot, entry, { signal, onLoaded }) {
  const seeAllHref = hrefFor("catalog", [entry.addonId, entry.type, entry.catalogId], { base: entry.addonBaseUrl, name: entry.catalogName });
  const title = `${entry.catalogName}`;
  // Addons often offer the same catalog name for movies and series, so the type tells them apart.
  const subtitle = [entry.addonName, toDisplayTypeLabel(entry.type)].filter(Boolean).join(" · ");
  const load = async () => {
    const result = await catalogRepository.getCatalog({
      addonBaseUrl: entry.addonBaseUrl,
      addonId: entry.addonId,
      addonName: entry.addonName,
      catalogId: entry.catalogId,
      catalogName: entry.catalogName,
      type: entry.type,
      skipStep: catalogSkipStep(entry),
      supportsSkip: true,
      signal
    });
    if (signal.aborted) return;
    if (result.status !== "success" || !result.data?.items?.length) {
      // An addon that fails or has nothing to show collapses instead of leaving a broken row.
      slot.remove();
      return;
    }
    clear(slot).append(
      row({
        title,
        subtitle,
        seeAllHref,
        items: result.data.items.slice(0, 24).map(posterCard)
      })
    );
    onLoaded?.(result.data.items);
  };
  clear(slot).append(row({ title, subtitle, items: skeletonRow() }));
  return load;
}

export function mountHome(node) {
  const heroSlot = h("div", { class: "hero" });
  const continueSlot = h("div", {});
  const rows = h("div", { class: "rows" });
  node.append(heroSlot, continueSlot, rows);

  let controller = null;
  let stopHero = () => {};
  let observer = null;
  let loadedSignature = "";

  async function load({ force = false } = {}) {
    renderContinueWatching(continueSlot);
    const addons = await loadInstalledAddons().catch((error) => {
      console.warn("Addons failed to load", error);
      return [];
    });
    const signature = JSON.stringify([
      addons.map((addon) => addon.baseUrl),
      HomeCatalogStore.get()?.disabled,
      HomeCatalogStore.get()?.order
    ]);
    if (!force && signature === loadedSignature) return;
    loadedSignature = signature;

    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    observer?.disconnect();
    stopHero();
    clear(rows);
    clear(heroSlot);

    const store = HomeCatalogStore.get() || {};
    const entries = buildOrderedHomeCatalogItems(
      addons,
      [],
      store.order || store.catalogOrder || [],
      store.disabled || store.disabledCatalogs || [],
      store.customTitles || {}
    ).filter((entry) => !entry.isDisabled && !entry.isCollection && entry.catalogId);

    heroSlot.hidden = !entries.length;
    if (!entries.length) {
      rows.append(
        emptyState({
          iconName: "extension",
          title: "No catalogs yet",
          detail: addons.length
            ? "Your installed addons don't offer any catalogs for Home."
            : "Add an addon in Settings to fill Home with content.",
          action: button("Manage addons", () => navigate("settings", ["addons"]), { kind: "primary" })
        })
      );
      return;
    }

    const first = heroCatalog(entries);
    let heroSet = false;
    observer = new IntersectionObserver(
      (records) => {
        records.forEach((record) => {
          if (!record.isIntersecting) return;
          observer.unobserve(record.target);
          record.target.__load?.().catch((error) => {
            if (error?.name !== "AbortError") console.warn("Catalog failed", error);
          });
        });
      },
      { rootMargin: "400px 0px" }
    );
    entries.forEach((entry) => {
      const slot = h("div", { class: "row-slot" });
      rows.append(slot);
      slot.__load = renderCatalogRow(slot, entry, {
        signal,
        onLoaded: (items) => {
          if (!heroSet && entry === first) {
            heroSet = true;
            stopHero = renderHero(heroSlot, items);
          }
        }
      });
      observer.observe(slot);
    });
  }

  rows.append(h("div", { class: "center-pad" }, spinner()));
  load().catch((error) => {
    toast(error?.message || "Home couldn't load", { error: true });
  });

  const unsubscribeSync = StartupSyncService.subscribeToPullCompleted?.(() => {
    load({ force: StartupSyncService.getLastPullChangedHomeInputs?.() === true }).catch(() => null);
  });
  const unsubscribeAddons = addonRepository.onInstalledAddonsChanged?.(() => {
    load().catch(() => null);
  });

  return {
    cleanup() {
      controller?.abort();
      observer?.disconnect();
      stopHero();
      unsubscribeSync?.();
      unsubscribeAddons?.();
    },
    onShow() {
      renderContinueWatching(continueSlot);
    }
  };
}
