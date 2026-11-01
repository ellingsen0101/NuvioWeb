// Stremio-protocol addons are expected to send permissive CORS headers, and most do. For the ones
// that don't, a request that the browser blocks is retried through the authenticated backend proxy.
// This wraps fetch instead of editing upstream's httpClient so that upstream merges stay clean.
import { Backend } from "./backend.js";

const ADDON_PATH = /\/(manifest\.json|(catalog|meta|stream|subtitles)\/[^?#]+\.json)(?:[?#]|$)/i;
const blockedOrigins = new Set();

export function isAddonRequest(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && ADDON_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function viaProxy(url, signal) {
  const body = await Backend.proxyText(url, { kind: "addon", signal });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

export function installAddonFetchFallback() {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function fetchWithAddonFallback(input, init = {}) {
    const url = typeof input === "string" ? input : input?.url;
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    if (method !== "GET" || !isAddonRequest(url)) return nativeFetch(input, init);

    const origin = new URL(url).origin;
    if (blockedOrigins.has(origin) && Backend.isConnected()) return viaProxy(url, init?.signal);
    try {
      return await nativeFetch(input, init);
    } catch (error) {
      if (error?.name === "AbortError" || !Backend.isConnected()) throw error;
      blockedOrigins.add(origin);
      return viaProxy(url, init?.signal).catch(() => {
        throw error;
      });
    }
  };
}
