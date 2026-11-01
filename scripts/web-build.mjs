// Builds the Nuvio Web PWA from web/ into dist-web/. The TV build (scripts/build.mjs) stays as is.
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";
import { buildI18nBundles } from "./buildI18nBundles.mjs";
import { readEnvProperties } from "./envProperties.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(rootDir, "web");
const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));

// Only values that are public by design reach the browser. TRAKT_CLIENT_SECRET stays out on
// purpose: anything in this list is readable by every visitor.
const PUBLIC_ENV_KEYS = [
  "NUVIO_SUPABASE_URL",
  "NUVIO_SUPABASE_ANON_KEY",
  "NUVIO_SUPABASE_FALLBACK_URL",
  "TV_LOGIN_WEB_BASE_URL",
  "DEVICE_LOGIN_WEB_BASE_URL",
  "AVATAR_PUBLIC_BASE_URL",
  "INTRODB_API_URL",
  "SUPPORT_URL",
  "TMDB_API_KEY",
  "NUVIO_BACKEND_URL"
];

async function readPublicEnv() {
  const { env: properties = {} } = await readEnvProperties({ rootDir }).catch(() => ({}));
  const env = {};
  for (const key of PUBLIC_ENV_KEYS) {
    const value = process.env[key] ?? properties[key];
    if (value) env[key] = String(value);
  }
  return env;
}

function esbuildOptions(outDir, { dev }) {
  return {
    absWorkingDir: rootDir,
    entryPoints: {
      app: "web/src/main.js",
      styles: "web/src/styles/app.css",
      "hls-engine": "web/src/player/hlsEntry.js"
    },
    bundle: true,
    format: "esm",
    // No code splitting: upstream's many dynamic imports would become 60+ requests at startup, which
    // is slow over mobile networks. hls.js is the one large module most iPhones never need (native
    // HLS), so it is a separate entry loaded on demand.
    splitting: false,
    external: ["./hls-engine.js"],
    target: ["safari15", "chrome100", "firefox100"],
    outdir: path.join(outDir, "build"),
    // hls-engine keeps a stable name because the app imports it by path. The service worker's cache
    // version changes with its contents.
    entryNames: "[name]",
    assetNames: "asset-[hash]",
    metafile: true,
    minify: !dev,
    sourcemap: dev ? "inline" : false,
    legalComments: "linked",
    logLevel: "warning",
    define: {
      __NUVIO_APP_VERSION__: JSON.stringify(packageJson.version),
      __NUVIO_WEB_DEV__: JSON.stringify(Boolean(dev))
    },
    loader: { ".svg": "file", ".png": "file", ".woff2": "file", ".ttf": "file" }
  };
}

async function listFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
    })
  );
  return nested.flat().map((file) => file.split(path.sep).join("/"));
}

async function writeStaticFiles(outDir, metafile) {
  await cp(path.join(webDir, "public"), outDir, { recursive: true });
  await cp(path.join(rootDir, "assets", "brand"), path.join(outDir, "assets", "brand"), {
    recursive: true
  });
  await mkdir(path.join(outDir, "assets", "libs"), { recursive: true });
  await cp(
    path.join(rootDir, "assets", "libs", "qrcode-generator.js"),
    path.join(outDir, "assets", "libs", "qrcode-generator.js")
  );
  await cp(path.join(rootDir, "LICENSE"), path.join(outDir, "LICENSE.txt"));

  const outputs = Object.entries(metafile.outputs).map(([file, meta]) => ({
    file: path.relative(outDir, path.resolve(rootDir, file)).split(path.sep).join("/"),
    entryPoint: meta.entryPoint || ""
  }));
  const jsEntry = outputs.find((output) => output.entryPoint === "web/src/main.js")?.file;
  const cssEntry = outputs.find((output) => output.file.endsWith(".css"))?.file;

  const template = await readFile(path.join(webDir, "index.html"), "utf8");
  await writeFile(
    path.join(outDir, "index.html"),
    template
      .replaceAll("%APP_JS%", `./${jsEntry}`)
      .replaceAll("%APP_CSS%", `./${cssEntry}`)
      .replaceAll("%APP_VERSION%", packageJson.version)
  );

  const env = await readPublicEnv();
  await writeFile(
    path.join(outDir, "nuvio.env.js"),
    `globalThis.__NUVIO_ENV__ = ${JSON.stringify(env, null, 2)};\n`
  );
}

// The precache is limited to the application shell. Nothing under it is account or media data.
async function writeServiceWorker(outDir) {
  const files = (await listFiles(outDir)).filter(
    (file) =>
      file !== "sw.js" &&
      file !== "nuvio.env.js" &&
      !file.startsWith("res/i18n/") &&
      // iPhones use native HLS and never load this, so it isn't worth pre-downloading.
      file !== "build/hls-engine.js" &&
      !file.endsWith(".LEGAL.txt") &&
      !file.startsWith("assets/brand/app_logo_wordmark_")
  );
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update(await readFile(path.join(outDir, file)));
  const template = await readFile(path.join(webDir, "sw.template.js"), "utf8");
  await writeFile(
    path.join(outDir, "sw.js"),
    template
      .replace("__CACHE_VERSION__", hash.digest("hex").slice(0, 16))
      .replace("__PRECACHE_FILES__", JSON.stringify(["./", ...files.map((file) => `./${file}`)]))
  );
}

export async function buildWeb({ outDir = path.join(rootDir, "dist-web"), dev = false } = {}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const result = await build(esbuildOptions(outDir, { dev }));
  await writeStaticFiles(outDir, result.metafile);
  await buildI18nBundles({ rootDir, distDir: outDir });
  await writeServiceWorker(outDir);
  return result;
}

export async function watchWeb({ outDir, onRebuild }) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const ctx = await context({
    ...esbuildOptions(outDir, { dev: true }),
    plugins: [
      {
        name: "web-static",
        setup(pluginBuild) {
          pluginBuild.onEnd(async (result) => {
            if (result.metafile) {
              await writeStaticFiles(outDir, result.metafile);
              await writeServiceWorker(outDir);
              onRebuild?.(result);
            }
          });
        }
      }
    ]
  });
  await buildI18nBundles({ rootDir, distDir: outDir });
  await ctx.watch();
  return ctx;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildWeb();
  const sizes = Object.entries(result.metafile.outputs)
    .map(([file, meta]) => [path.basename(file), meta.bytes])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  console.log("dist-web built. Largest outputs:");
  for (const [file, bytes] of sizes) console.log(`  ${(bytes / 1024).toFixed(0).padStart(6)} KB  ${file}`);
}
