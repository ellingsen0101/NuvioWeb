import { savedLibraryRepository } from "../../../js/data/repository/savedLibraryRepository.js";
import { StartupSyncService } from "../../../js/core/profile/startupSyncService.js";
import { clear, emptyState, h } from "../lib/dom.js";
import { posterCard } from "../components/cards.js";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "movie", label: "Movies" },
  { id: "series", label: "Series" }
];

export function mountLibrary(node) {
  let filter = "all";
  const chips = h("div", { class: "chips" });
  const content = h("div", {});

  async function render() {
    const items = await savedLibraryRepository.getAll(500).catch(() => []);
    chips.replaceChildren(
      ...FILTERS.map((entry) =>
        h(
          "button",
          {
            type: "button",
            class: `chip chip-toggle ${entry.id === filter ? "is-active" : ""}`,
            onClick: () => {
              filter = entry.id;
              render();
            }
          },
          entry.label
        )
      )
    );
    const visible = items.filter((item) => filter === "all" || item.type === filter);
    clear(content);
    if (!visible.length) {
      content.append(
        emptyState({
          iconName: "video_library",
          title: items.length ? "Nothing in this filter" : "Your library is empty",
          detail: items.length ? "" : "Save a movie or show from its page and it appears here on every device."
        })
      );
      return;
    }
    content.append(
      h(
        "div",
        { class: "poster-grid" },
        visible.map((item) =>
          posterCard({ ...item, id: item.contentId || item.id, name: item.title || item.name, type: item.contentType || item.type })
        )
      )
    );
  }

  node.append(h("header", { class: "page-head" }, h("h1", {}, "Library")), chips, content);
  render();
  const unsubscribe = StartupSyncService.subscribeToPullCompleted?.(() => render());

  return {
    cleanup: () => unsubscribe?.(),
    onShow: render
  };
}
