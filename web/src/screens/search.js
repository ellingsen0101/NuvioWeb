import { catalogSupportsExtra, catalogRequiresExtras } from "../../../js/core/addons/homeCatalogs.js";
import { SearchHistoryStore } from "../../../js/data/local/searchHistoryStore.js";
import { loadInstalledAddons } from "../services/addons.js";
import { catalogRepository } from "../../../js/data/repository/catalogRepository.js";
import { clear, emptyState, h, icon, iconButton, spinner } from "../lib/dom.js";
import { hrefFor } from "../lib/router.js";
import { posterCard, row } from "../components/cards.js";

const SEARCH_DEBOUNCE_MS = 400;

async function searchableCatalogs() {
  const addons = await loadInstalledAddons();
  return addons.flatMap((addon) =>
    (addon.catalogs || [])
      .filter((catalog) => catalogSupportsExtra(catalog, "search"))
      .map((catalog) => ({ addon, catalog }))
  );
}

async function browseCatalogs() {
  const addons = await loadInstalledAddons();
  return addons.flatMap((addon) =>
    (addon.catalogs || [])
      .filter((catalog) => !catalogRequiresExtras(catalog))
      .map((catalog) => ({ addon, catalog }))
  );
}

export function mountSearch(node, route) {
  const input = h("input", {
    type: "search",
    class: "search-input",
    placeholder: "Search movies and shows",
    "aria-label": "Search",
    enterKeyHint: "search",
    autocapitalize: "off",
    autocomplete: "off",
    value: route.query.q || ""
  });
  const results = h("div", { class: "search-results" });
  let timer = 0;
  let controller = null;

  async function renderIdle() {
    clear(results);
    const history = SearchHistoryStore.list();
    if (history.length) {
      results.append(
        h(
          "section",
          { class: "search-history" },
          h("h2", {}, "Recent searches"),
          h(
            "div",
            { class: "chips" },
            history.map((query) =>
              h(
                "span",
                { class: "chip" },
                h("button", { type: "button", onClick: () => { input.value = query; run(query); } }, query),
                iconButton("close", `Remove ${query}`, () => {
                  SearchHistoryStore.remove(query);
                  renderIdle();
                })
              )
            )
          )
        )
      );
    }
    const catalogs = await browseCatalogs().catch(() => []);
    if (input.value.trim()) return;
    results.append(
      h(
        "section",
        { class: "search-browse" },
        h("h2", {}, "Browse"),
        catalogs.length
          ? h(
              "div",
              { class: "browse-grid" },
              catalogs.map(({ addon, catalog }) =>
                h(
                  "a",
                  {
                    class: "browse-tile",
                    href: hrefFor("catalog", [addon.id, catalog.apiType, catalog.id], { base: addon.baseUrl, name: catalog.name })
                  },
                  h("strong", {}, catalog.name),
                  h("span", {}, `${catalog.apiType} · ${addon.displayName}`)
                )
              )
            )
          : h("p", { class: "muted" }, "Install an addon with catalogs to browse here.")
      )
    );
  }

  async function run(rawQuery) {
    const query = String(rawQuery || "").trim();
    controller?.abort();
    if (!query) {
      renderIdle();
      return;
    }
    controller = new AbortController();
    const { signal } = controller;
    clear(results).append(h("div", { class: "center-pad" }, spinner("Searching")));
    SearchHistoryStore.save(query);

    const catalogs = await searchableCatalogs().catch(() => []);
    if (signal.aborted) return;
    if (!catalogs.length) {
      clear(results).append(
        emptyState({ iconName: "search_off", title: "No searchable addons", detail: "None of your installed addons offer search." })
      );
      return;
    }

    let shown = 0;
    let pending = catalogs.length;
    const rows = h("div", { class: "rows" });
    const status = h("div", { class: "center-pad" }, spinner("Searching"));
    clear(results).append(rows, status);
    await Promise.all(
      catalogs.map(async ({ addon, catalog }) => {
        const result = await catalogRepository
          .getCatalog({
            addonBaseUrl: addon.baseUrl,
            addonId: addon.id,
            addonName: addon.displayName,
            catalogId: catalog.id,
            catalogName: catalog.name,
            type: catalog.apiType,
            extraArgs: { search: query },
            signal
          })
          .catch(() => null);
        pending -= 1;
        if (signal.aborted) return;
        if (result?.status === "success" && result.data?.items?.length) {
          shown += result.data.items.length;
          rows.append(
            row({
              title: `${catalog.name}`,
              subtitle: addon.displayName,
              items: result.data.items.map(posterCard)
            })
          );
        }
      })
    );
    if (signal.aborted || pending > 0) return;
    status.remove();
    if (!shown) {
      results.append(
        emptyState({ iconName: "search_off", title: `No results for “${query}”`, detail: "Try a different title or check your addons." })
      );
    }
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => run(input.value), SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      clearTimeout(timer);
      input.blur();
      run(input.value);
    }
  });

  node.append(
    h("header", { class: "page-head search-head" }, h("label", { class: "search-box" }, icon("search"), input)),
    results
  );
  run(input.value);

  return {
    cleanup() {
      clearTimeout(timer);
      controller?.abort();
    }
  };
}
