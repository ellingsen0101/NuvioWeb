import { h, icon, image } from "../lib/dom.js";
import { hrefFor } from "../lib/router.js";

export function detailHref(item) {
  return hrefFor("detail", [item.type || item.catalogType || "movie", item.id], {
    addon: item.addonBaseUrl || null
  });
}

export function posterCard(item) {
  return h(
    "a",
    { class: "poster-card", href: detailHref(item), title: item.name },
    h(
      "span",
      { class: "poster-art" },
      image(item.poster, { alt: "" }),
      h("span", { class: "poster-fallback" }, item.name)
    ),
    h("span", { class: "poster-title" }, item.name),
    item.releaseInfo ? h("span", { class: "poster-sub" }, item.releaseInfo) : null
  );
}

export function skeletonRow(count = 8) {
  return Array.from({ length: count }, () =>
    h("div", { class: "poster-card is-skeleton", "aria-hidden": "true" }, h("span", { class: "poster-art" }))
  );
}

export function continueCard({ href, title, subtitle, art, fraction, onRemove }) {
  return h(
    "div",
    { class: "continue-card" },
    h(
      "a",
      { href, class: "continue-link", title },
      h(
        "span",
        { class: "continue-art" },
        image(art, { alt: "" }),
        h("span", { class: "continue-play" }, icon("play_arrow", { filled: true })),
        h("span", { class: "continue-bar" }, h("span", { style: { width: `${Math.round(fraction * 100)}%` } }))
      ),
      h("span", { class: "poster-title" }, title),
      subtitle ? h("span", { class: "poster-sub" }, subtitle) : null
    ),
    onRemove
      ? h(
          "button",
          { type: "button", class: "continue-remove", "aria-label": `Remove ${title} from Continue Watching`, onClick: onRemove },
          icon("close")
        )
      : null
  );
}

// A touch-scrollable row with arrow buttons for mouse users.
export function row({ title, seeAllHref = null, subtitle = null, items = [], className = "" }) {
  const track = h("div", { class: "row-track", tabIndex: -1 }, items);
  const scrollBy = (direction) => track.scrollBy({ left: direction * track.clientWidth * 0.85, behavior: "smooth" });
  return h(
    "section",
    { class: `row ${className}`.trim() },
    h(
      "header",
      { class: "row-head" },
      h("div", {}, h("h2", {}, title), subtitle ? h("p", { class: "row-sub" }, subtitle) : null),
      seeAllHref ? h("a", { class: "row-more", href: seeAllHref }, "See all", icon("chevron_right")) : null
    ),
    h(
      "div",
      { class: "row-viewport" },
      h("button", { type: "button", class: "row-arrow row-arrow-left", "aria-label": "Scroll left", tabIndex: -1, onClick: () => scrollBy(-1) }, icon("chevron_left")),
      track,
      h("button", { type: "button", class: "row-arrow row-arrow-right", "aria-label": "Scroll right", tabIndex: -1, onClick: () => scrollBy(1) }, icon("chevron_right"))
    )
  );
}
