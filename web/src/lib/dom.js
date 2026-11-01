// Minimal DOM helpers. Text goes through textContent, so addon-supplied strings are never parsed as HTML.
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== "list" && key !== "form") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function icon(name, { filled = false, className = "" } = {}) {
  return h(
    "span",
    { class: `icon ${filled ? "icon-filled" : ""} ${className}`.trim(), "aria-hidden": "true" },
    name
  );
}

export function iconButton(name, label, onClick, { className = "", filled = false } = {}) {
  return h(
    "button",
    { type: "button", class: `icon-btn ${className}`.trim(), "aria-label": label, title: label, onClick },
    icon(name, { filled })
  );
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function spinner(label = "Loading") {
  return h("div", { class: "spinner", role: "status", "aria-label": label });
}

export function emptyState({ iconName = "info", title, detail, action }) {
  return h(
    "div",
    { class: "empty-state" },
    icon(iconName),
    h("h3", {}, title),
    detail ? h("p", {}, detail) : null,
    action || null
  );
}

export function button(label, onClick, { kind = "secondary", iconName = null, ...rest } = {}) {
  return h(
    "button",
    { type: "button", class: `btn btn-${kind}`, onClick, ...rest },
    iconName ? icon(iconName) : null,
    h("span", {}, label)
  );
}

let toastTimer = 0;
export function toast(message, { error = false } = {}) {
  document.querySelector(".toast")?.remove();
  const node = h("div", { class: `toast ${error ? "toast-error" : ""}`, role: "status" }, message);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 3600);
}

// Drawer on phones, centered dialog on larger screens.
export function openSheet({ title, content, onClose, className = "" }) {
  const close = () => {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    document.documentElement.classList.remove("sheet-open");
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  const backdrop = h(
    "div",
    {
      class: "sheet-backdrop",
      onClick: (event) => {
        if (event.target === backdrop) close();
      }
    },
    h(
      "div",
      { class: `sheet ${className}`.trim(), role: "dialog", "aria-modal": "true", "aria-label": title },
      h(
        "header",
        { class: "sheet-head" },
        h("h2", {}, title),
        iconButton("close", "Close", () => close())
      ),
      h("div", { class: "sheet-body" }, content)
    )
  );
  document.addEventListener("keydown", onKey);
  document.documentElement.classList.add("sheet-open");
  (document.querySelector(".player-root") || document.body).append(backdrop);
  return { close, body: backdrop.querySelector(".sheet-body") };
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

// Artwork comes from third-party addons, so only http(s) image URLs are ever assigned.
export function safeImageUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("//")) return `https:${text}`;
  return /^https?:\/\//i.test(text) ? text : "";
}

export function safeLinkUrl(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) ? text : "";
}

export function image(src, { alt = "", className = "", eager = false } = {}) {
  const url = safeImageUrl(src);
  const img = h("img", {
    class: className,
    alt,
    decoding: "async",
    loading: eager ? "eager" : "lazy",
    referrerPolicy: "no-referrer",
    draggable: false
  });
  img.addEventListener("load", () => img.classList.add("is-loaded"), { once: true });
  img.addEventListener(
    "error",
    () => {
      img.classList.add("is-broken");
      img.removeAttribute("src");
    },
    { once: true }
  );
  if (url) img.src = url;
  else img.classList.add("is-broken");
  return img;
}
