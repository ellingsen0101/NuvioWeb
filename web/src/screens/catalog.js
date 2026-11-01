// "See all" grid for one addon catalog, with genre filter and paging through the addon's skip extra.
import { catalogSkipStep, catalogSupportsExtra } from "../../../js/core/addons/homeCatalogs.js";
import { loadInstalledAddons } from "../services/addons.js";
import { catalogRepository } from "../../../js/data/repository/catalogRepository.js";
import { clear, emptyState, h, iconButton, spinner } from "../lib/dom.js";
import { goBack } from "../lib/router.js";
import { posterCard } from "../components/cards.js";

export function mountCatalog(node, route) {
  const [addonId, type, catalogId] = route.segments;
  const addonBaseUrl = route.query.base;
  const controller = new AbortController();
  const grid = h("div", { class: "poster-grid" });
  const footer = h("div", { class: "center-pad" });
  const filters = h("div", { class: "chips chips-scroll" });
  let genre = route.query.genre || "";
  let nextSkip = 0;
  let hasMore = true;
  let loading = false;
  let catalog = null;
  let requestGeneration = 0;

  const sentinel = h("div", { class: "grid-sentinel" });
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadMore();
  }, { rootMargin: "600px 0px" });

  async function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    const generation = requestGeneration;
    footer.replaceChildren(spinner());
    const result = await catalogRepository.getCatalog({
      addonBaseUrl,
      addonId,
      catalogId,
      catalogName: route.query.name,
      addonName: "",
      type,
      skip: nextSkip,
      skipStep: catalogSkipStep(catalog || {}),
      extraArgs: genre ? { genre } : {},
      supportsSkip: catalog ? catalogSupportsExtra(catalog, "skip") : true,
      signal: controller.signal
    });
    if (controller.signal.aborted || generation !== requestGeneration) return;
    loading = false;
    clear(footer);
    if (result.status !== "success") {
      hasMore = false;
      if (!grid.childElementCount) {
        footer.append(emptyState({ iconName: "cloud_off", title: "This catalog couldn't load", detail: "The addon didn't respond." }));
      }
      return;
    }
    grid.append(...result.data.items.map(posterCard));
    hasMore = Boolean(result.data.hasMore) && result.data.nextSkip > nextSkip;
    nextSkip = result.data.nextSkip;
    if (!grid.childElementCount) {
      footer.append(emptyState({ iconName: "movie", title: "Nothing here", detail: genre ? `No titles for ${genre}.` : "" }));
    }
  }

  function selectGenre(value) {
    genre = value;
    requestGeneration += 1;
    loading = false;
    nextSkip = 0;
    hasMore = true;
    clear(grid);
    renderFilters();
    loadMore();
  }

  function renderFilters() {
    const options = (catalog?.extra || []).find((entry) => String(entry?.name || "").toLowerCase() === "genre")?.options || [];
    clear(filters);
    if (!options.length) return;
    const required = (catalog?.extra || []).some((entry) => String(entry?.name).toLowerCase() === "genre" && entry.isRequired);
    const values = required ? options : ["", ...options];
    if (required && !genre) genre = options[0];
    filters.append(
      ...values.map((value) =>
        h(
          "button",
          {
            type: "button",
            class: `chip chip-toggle ${value === genre ? "is-active" : ""}`,
            onClick: () => selectGenre(value)
          },
          value || "All"
        )
      )
    );
  }

  node.append(
    h(
      "header",
      { class: "page-head page-head-back" },
      iconButton("arrow_back", "Back", () => goBack()),
      h("h1", {}, route.query.name || "Catalog")
    ),
    filters,
    grid,
    footer,
    sentinel
  );

  (async () => {
    const addons = await loadInstalledAddons().catch(() => []);
    catalog = addons
      .find((addon) => addon.baseUrl === addonBaseUrl)
      ?.catalogs?.find((entry) => entry.id === catalogId && entry.apiType === type) || null;
    renderFilters();
    observer.observe(sentinel);
    loadMore();
  })();

  return () => {
    controller.abort();
    observer.disconnect();
  };
}
