// Thin wrapper around WebTorrent. Torrents are shared between playback sessions by info hash and
// removed, along with their downloaded data, a short while after the last session lets go.
import path from "node:path";
import { rm } from "node:fs/promises";
import WebTorrent from "webtorrent";
import { PRIVATE_PEER_RANGES, parsePublicUrl } from "./netGuard.js";

const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://exodus.desync.com:6969/announce",
  "wss://tracker.webtorrent.dev"
];
const HASH_RE = /^[0-9a-f]{40}$/;

export function isValidInfoHash(value) {
  return HASH_RE.test(String(value || ""));
}

// Stremio streams list swarm sources as "tracker:<url>" or "dht:<hash>". Only public trackers are
// kept: a tracker URL comes from an addon, so it must not be able to reach internal addresses.
export function trackersFromSources(sources, { allowPrivate = false } = {}) {
  const trackers = new Set();
  for (const source of Array.isArray(sources) ? sources.slice(0, 64) : []) {
    const text = String(source || "");
    const url = text.startsWith("tracker:") ? text.slice("tracker:".length) : "";
    if (!/^(udp|https?|wss?):\/\//i.test(url)) continue;
    try {
      const parsed = new URL(url);
      parsePublicUrl(`http://${parsed.host}/`, { allowPrivate });
      trackers.add(url);
    } catch {
      // Unusable or internal tracker. The rest of the swarm still works.
    }
  }
  return [...trackers];
}

export function createTorrentEngine(config, { logger = console } = {}) {
  const client = new WebTorrent({
    maxConns: config.maxConnections,
    downloadLimit: config.downloadLimitBytes,
    uploadLimit: config.uploadLimitBytes,
    // Web seed URLs come from torrent metadata, which is untrusted: they would be an SSRF route.
    webSeeds: false,
    dht: !config.allowPrivatePeers,
    utp: false,
    lsd: false,
    natUpnp: false,
    natPmp: false,
    ...(config.allowPrivatePeers ? {} : { blocklist: PRIVATE_PEER_RANGES })
  });
  client.on("error", (error) => logger.warn?.(`WebTorrent error: ${error.message}`));

  const entries = new Map();

  function release(infoHash) {
    const entry = entries.get(infoHash);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    entry.lastReleasedAt = Date.now();
  }

  async function remove(infoHash) {
    const entry = entries.get(infoHash);
    if (!entry) return;
    entries.delete(infoHash);
    await new Promise((resolve) => {
      entry.torrent.destroy({ destroyStore: true }, () => resolve());
    }).catch(() => null);
    await rm(entry.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => null);
  }

  return {
    get activeCount() {
      return entries.size;
    },

    // Waits for metadata. Rejects with code METADATA_TIMEOUT when no peer provides it in time.
    async acquire({ infoHash, sources = [] }) {
      let entry = entries.get(infoHash);
      if (!entry) {
        const idle = [...entries.entries()].filter(([, value]) => value.refs === 0);
        if (entries.size >= config.maxTorrents && idle.length) {
          idle.sort((a, b) => a[1].lastReleasedAt - b[1].lastReleasedAt);
          await remove(idle[0][0]);
        }
        if (entries.size >= config.maxTorrents) {
          throw Object.assign(new Error("The backend is already streaming as many torrents as it allows."), { code: "TOO_MANY_TORRENTS", status: 429 });
        }
        const directory = path.join(config.cacheDir, "torrents", infoHash);
        const announce = [...new Set([...trackersFromSources(sources, { allowPrivate: config.allowPrivatePeers }), ...(config.allowPrivatePeers ? [] : DEFAULT_TRACKERS)])];
        const torrent = client.add(infoHash, { path: directory, announce, destroyStoreOnDestroy: true, deselect: true });
        entry = { torrent, directory, refs: 0, lastReleasedAt: 0 };
        entries.set(infoHash, entry);
        torrent.on("error", (error) => {
          entry.error = error;
          logger.warn?.(`Torrent ${infoHash.slice(0, 8)} error: ${error.message}`);
        });
      }
      entry.refs += 1;

      const { torrent } = entry;
      if (!torrent.metadata) {
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(Object.assign(new Error("No peers provided this torrent's details in time. It may have no seeders."), { code: "METADATA_TIMEOUT" }));
            }, config.metadataTimeoutMs);
            torrent.once("metadata", () => {
              clearTimeout(timer);
              resolve();
            });
            torrent.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
          });
        } catch (error) {
          release(infoHash);
          throw error;
        }
      }
      return torrent;
    },

    release,

    addPeer(infoHash, address) {
      entries.get(infoHash)?.torrent.addPeer(address);
    },

    // Removes torrents nobody has used for the linger period.
    async sweep(now = Date.now()) {
      for (const [infoHash, entry] of entries) {
        if (entry.refs <= 0 && now - entry.lastReleasedAt > config.torrentLingerMs) await remove(infoHash);
      }
    },

    async evictIdle() {
      for (const [infoHash, entry] of entries) {
        if (entry.refs <= 0) await remove(infoHash);
      }
    },

    async destroy() {
      for (const infoHash of [...entries.keys()]) await remove(infoHash);
      await new Promise((resolve) => client.destroy(() => resolve()));
    }
  };
}
