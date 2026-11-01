// Hash router, so the PWA works from any static host with no rewrite rules.
// Root tabs stay mounted while hidden, which keeps Home's loaded rows and scroll position on Back.
const KEEP_ALIVE = new Set(["home", "search", "library"]);

export function parseHash(hash = location.hash) {
  const [rawPath, rawQuery = ""] = String(hash || "").replace(/^#\/?/, "").split("?");
  const segments = rawPath.split("/").filter(Boolean).map(decodeURIComponent);
  return {
    name: segments[0] || "home",
    segments: segments.slice(1),
    query: Object.fromEntries(new URLSearchParams(rawQuery)),
    key: rawPath + (rawQuery ? `?${rawQuery}` : "")
  };
}

export function hrefFor(name, segments = [], query = null) {
  const path = [name, ...segments].map(encodeURIComponent).join("/");
  const search = query
    ? new URLSearchParams(Object.entries(query).filter(([, value]) => value != null && value !== "")).toString()
    : "";
  return `#/${path}${search ? `?${search}` : ""}`;
}

export function navigate(name, segments = [], query = null, { replace = false } = {}) {
  const href = hrefFor(name, segments, query);
  if (replace) location.replace(href);
  else location.hash = href;
}

// history.length is unreliable in a fresh standalone launch, so the router tracks its own stack.
const visited = [];

export function goBack(fallback = "home") {
  if (visited.length > 1) history.back();
  else navigate(fallback, [], null, { replace: true });
}

function recordVisit(key) {
  if (visited.length > 1 && visited[visited.length - 2] === key) visited.pop();
  else if (visited[visited.length - 1] !== key) visited.push(key);
}

export function createRouter({ outlet, routes, guard, onChange }) {
  const alive = new Map();
  let current = null;
  const scrollByKey = new Map();

  function unmount(entry) {
    try {
      entry.cleanup?.();
    } catch (error) {
      console.warn("Screen cleanup failed", error);
    }
    entry.node.remove();
  }

  async function render() {
    const route = parseHash();
    const redirect = guard?.(route);
    if (redirect) {
      navigate(redirect, [], null, { replace: true });
      return;
    }
    const factory = routes[route.name] || routes.home;

    if (current) {
      scrollByKey.set(current.key, window.scrollY);
      if (KEEP_ALIVE.has(current.name)) {
        current.node.hidden = true;
        current.onHide?.();
      } else {
        unmount(current);
      }
    }

    let entry = alive.get(route.key);
    if (entry) {
      entry.node.hidden = false;
      entry.onShow?.();
    } else {
      const node = document.createElement("div");
      node.className = `screen screen-${route.name}`;
      outlet.append(node);
      entry = { key: route.key, name: route.name, node, cleanup: null };
      if (KEEP_ALIVE.has(route.name)) {
        // One live instance per tab: a new query on the same tab replaces the old one.
        for (const [key, other] of alive) {
          if (other.name === route.name) {
            unmount(other);
            alive.delete(key);
          }
        }
        alive.set(route.key, entry);
      }
      current = entry;
      const result = await factory(node, route);
      if (typeof result === "function") entry.cleanup = result;
      else if (result) Object.assign(entry, result);
    }
    current = entry;
    recordVisit(route.key);
    onChange?.(route);
    const scrollY = scrollByKey.get(route.key) || 0;
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  }

  function reset() {
    for (const entry of alive.values()) unmount(entry);
    alive.clear();
    if (current && !KEEP_ALIVE.has(current.name)) unmount(current);
    current = null;
    scrollByKey.clear();
    visited.length = 0;
  }

  window.addEventListener("hashchange", () => render());
  return { render, reset };
}
