// Serves the production build from dist-web/ for self-hosting on your own machine. It listens on
// loopback only: put something that provides HTTPS in front of it, such as `tailscale serve`.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist-web");
const port = Number(process.env.PORT || 4173);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

http
  .createServer(async (request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const file = path.resolve(distDir, pathname === "/" ? "index.html" : pathname.slice(1));
    if (!file.startsWith(distDir + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Content-Length": info.size,
      // File names aren't content-hashed. The service worker handles versions, so always revalidate.
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff"
    });
    createReadStream(file).pipe(response);
  })
  .listen(port, "127.0.0.1", () => console.log(`Nuvio Web at http://127.0.0.1:${port}`));
