// Manual check against the real public swarm, with production security settings (private peers
// blocked, DHT and trackers on). It streams an openly licensed film, so it needs internet access,
// and it uploads to other peers while running, as all BitTorrent clients do.
//   Sintel (2010), Blender Foundation, CC BY 3.0
// Usage: node scripts/verify-public-torrent.mjs [infoHash]
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const SINTEL = "08ada5a7a6183aae1e09d831df6748d566095a10";
const infoHash = process.argv[2] || SINTEL;
const key = randomBytes(24).toString("base64url");
const TIMEOUT_MS = 5 * 60 * 1000;

const config = loadConfig({
  ACCESS_KEYS: key,
  TOKEN_SECRET: randomBytes(48).toString("base64url"),
  PORT: "0",
  CACHE_DIR: path.join(os.tmpdir(), `nuvio-public-torrent-${process.pid}`),
  METADATA_TIMEOUT_SECONDS: "180"
});
config.publicBaseUrl = null;
const app = await createApp(config, { logger: { info() {}, warn: (m) => console.log("  warn:", m), error: (m) => console.log("  error:", m) } });
const port = await app.listen();
const base = `http://127.0.0.1:${port}`;

async function call(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }
  });
  return response.json();
}

let exitCode = 1;
try {
  const { token } = await call("/v1/auth/session", { method: "POST", body: JSON.stringify({ accessKey: key }) });
  const created = await call("/v1/playback/torrent", {
    method: "POST",
    token,
    body: JSON.stringify({
      infoHash,
      capabilities: { h264: true, aac: true },
      sources: [
        "tracker:udp://tracker.opentrackr.org:1337/announce",
        "tracker:udp://explodie.org:6969",
        "tracker:udp://tracker.empire-js.us:1337",
        "tracker:wss://tracker.btorrent.xyz",
        "tracker:wss://tracker.openwebtorrent.com"
      ]
    })
  });
  console.log("Session created:", created.id ? "yes" : JSON.stringify(created));

  const started = Date.now();
  let status;
  let last = "";
  for (;;) {
    status = await call(`/v1/playback/${created.id}`, { token });
    const line = `${status.state} peers=${status.peers ?? 0}`;
    if (line !== last) console.log(`  ${Math.round((Date.now() - started) / 1000)}s ${line}`);
    last = line;
    if (status.state === "ready" || status.state === "error") break;
    if (Date.now() - started > TIMEOUT_MS) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (status.state === "error") throw new Error(`${status.code}: ${status.message}`);

  console.log(`Ready after ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`  file: ${status.filename}  of ${status.files.length} files`);
  console.log(`  mode: ${status.mode}  duration: ${Math.round(status.duration)}s  peers: ${status.peers}`);

  // Reads from the middle of the film, the way seeking does, and checks the data is real video.
  const fileSize = status.files[status.fileIndex].length;
  const seekStart = Math.floor(fileSize * 0.6);
  const seekStarted = Date.now();
  const direct = status.url.includes("/file");
  if (direct) {
    const response = await fetch(status.url, { headers: { Range: `bytes=${seekStart}-${seekStart + 1048575}` } });
    const bytes = Buffer.from(await response.arrayBuffer());
    console.log(`  seek read: HTTP ${response.status}, ${bytes.length} bytes in ${((Date.now() - seekStarted) / 1000).toFixed(1)}s, ${(status.downloadSpeed / 1048576).toFixed(1)} MB/s`);
    if (response.status !== 206 || bytes.length !== 1048576) throw new Error("Seek read failed");
  } else {
    const playlist = await (await fetch(status.url)).text();
    if (!playlist.includes("#EXTM3U")) throw new Error("No playlist");
  }

  // Runs asynchronously because the server answering this request lives in this same process.
  const probe = await new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", status.url], { timeout: 120000 }, (error, stdout) => resolve({ stdout: stdout || "" }));
  });
  console.log(`  decodable streams: ${probe.stdout.trim().replace(/\r?\n/g, ", ") || "none"}`);
  if (!probe.stdout.includes("video")) throw new Error("No decodable video");

  await call(`/v1/playback/${created.id}`, { method: "DELETE", token }).catch(() => null);
  console.log("PASS");
  exitCode = 0;
} catch (error) {
  console.log("FAIL:", error.message);
} finally {
  await app.close().catch(() => null);
  process.exit(exitCode);
}
