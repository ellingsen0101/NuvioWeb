// Client for the separately deployed streaming backend (server/). The access key is exchanged for
// a session token and never stored. Media URLs returned by the backend carry their own short-lived
// scoped tokens because <video> and HLS requests cannot send an Authorization header.
import { LocalStore } from "../../../js/core/storage/localStore.js";

const CONFIG_KEY = "webBackendConfig";

function normalizeBaseUrl(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) return "";
  const parsed = new URL(text);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Use an http(s) URL");
  // A secure page cannot call or play from an insecure backend, except on localhost.
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol === "http:" && !isLocal && location.protocol === "https:") {
    throw new Error("This backend needs HTTPS to work from an HTTPS page");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export class BackendError extends Error {
  constructor(message, { status = 0, code = "" } = {}) {
    super(message);
    this.name = "BackendError";
    this.status = status;
    this.code = code;
  }
}

function readConfig() {
  const stored = LocalStore.get(CONFIG_KEY, null);
  return {
    baseUrl: String(stored?.baseUrl || globalThis.__NUVIO_ENV__?.NUVIO_BACKEND_URL || "").replace(/\/+$/, ""),
    token: String(stored?.token || ""),
    expiresAt: Number(stored?.expiresAt || 0)
  };
}

async function request(path, { method = "GET", body, auth = true, signal, baseUrl } = {}) {
  const config = readConfig();
  const base = baseUrl || config.baseUrl;
  if (!base) throw new BackendError("No streaming backend is configured", { code: "NOT_CONFIGURED" });
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    if (!Backend.isConnected()) {
      throw new BackendError("Connect to your streaming backend in Settings", { code: "NOT_AUTHENTICATED" });
    }
    headers.Authorization = `Bearer ${config.token}`;
  }
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: "omit"
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new BackendError("The streaming backend could not be reached", { code: "UNREACHABLE" });
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    if (response.status === 401 && auth) Backend.clearSession();
    throw new BackendError(data?.message || `Backend error ${response.status}`, {
      status: response.status,
      code: data?.code || ""
    });
  }
  return data;
}

export const Backend = {
  getBaseUrl() {
    return readConfig().baseUrl;
  },

  isConfigured() {
    return Boolean(readConfig().baseUrl);
  },

  isConnected() {
    const { baseUrl, token, expiresAt } = readConfig();
    return Boolean(baseUrl && token && expiresAt > Date.now());
  },

  async connect(baseUrlInput, accessKey) {
    const baseUrl = normalizeBaseUrl(baseUrlInput);
    if (!baseUrl) throw new BackendError("Enter the backend URL");
    const data = await request("/v1/auth/session", {
      method: "POST",
      body: { accessKey },
      auth: false,
      baseUrl
    });
    LocalStore.set(CONFIG_KEY, { baseUrl, token: data.token, expiresAt: data.expiresAt });
    return data;
  },

  clearSession() {
    const { baseUrl } = readConfig();
    LocalStore.set(CONFIG_KEY, { baseUrl, token: "", expiresAt: 0 });
    window.dispatchEvent(new Event("nuvio:backend-signed-out"));
  },

  disconnect() {
    LocalStore.remove(CONFIG_KEY);
  },

  health() {
    return request("/healthz", { auth: false });
  },

  capabilities() {
    return request("/v1/capabilities");
  },

  createTorrentPlayback(payload, { signal } = {}) {
    return request("/v1/playback/torrent", { method: "POST", body: payload, signal });
  },

  createUrlPlayback(payload, { signal } = {}) {
    return request("/v1/playback/url", { method: "POST", body: payload, signal });
  },

  getPlayback(id, { signal } = {}) {
    return request(`/v1/playback/${encodeURIComponent(id)}`, { signal });
  },

  startHls(id, options) {
    return request(`/v1/playback/${encodeURIComponent(id)}/hls`, { method: "POST", body: options });
  },

  releasePlayback(id) {
    return request(`/v1/playback/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  // Survives the page closing, so a killed app doesn't hold a backend slot.
  releasePlaybackOnExit(id) {
    const { baseUrl, token } = readConfig();
    if (!baseUrl || !token) return;
    fetch(`${baseUrl}/v1/playback/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true,
      credentials: "omit"
    }).catch(() => null);
  },

  async proxyText(url, { kind = "subtitle", signal } = {}) {
    const data = await request("/v1/proxy/fetch", { method: "POST", body: { url, kind }, signal });
    return data.body;
  }
};
