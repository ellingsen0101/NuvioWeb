// Development server for the web app: esbuild watch plus a small static file server.
import http from "node:http";
import path from "node:path";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { watchWeb } from "./web-build.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, ".cache", "web-dev");
const port = Number(process.env.PORT || 5173);
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

await watchWeb({
  outDir,
  onRebuild: () => console.log(`[web-dev] rebuilt ${new Date().toLocaleTimeString()}`)
});

http
  .createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = path.resolve(outDir, relative);
    if (!file.startsWith(outDir + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Service-Worker-Allowed": "/"
    });
    createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`[web-dev] http://localhost:${port}`));
