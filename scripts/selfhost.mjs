// Runs the backend and the built app together on your own machine, restarting either if it stops.
// Both listen on loopback only. Something like `tailscale serve` provides HTTPS in front of them.
// Logs go to <data dir>/logs. They hold timings and errors, never tokens or source links.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.NUVIO_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "NuvioWeb");
const logDir = path.join(dataDir, "logs");
mkdirSync(logDir, { recursive: true });
const log = createWriteStream(path.join(logDir, "selfhost.log"), { flags: "a" });
const write = (name, line) => log.write(`${new Date().toISOString()} [${name}] ${line}\n`);

const services = [
  { name: "backend", script: path.join(rootDir, "server", "scripts", "dev.mjs") },
  { name: "app", script: path.join(rootDir, "scripts", "web-serve.mjs") }
];
const MAX_RESTART_DELAY_MS = 60000;
let stopping = false;
const children = new Set();

function start(service, attempt = 0) {
  const child = spawn(process.execPath, [service.script], { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  children.add(child);
  const startedAt = Date.now();
  write(service.name, "started");
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => chunk.split(/\r?\n/).filter(Boolean).forEach((line) => write(service.name, line)));
  }
  child.on("exit", (code) => {
    children.delete(child);
    if (stopping) return;
    // A service that ran for a while gets a fresh start. One that keeps failing backs off.
    const nextAttempt = Date.now() - startedAt > 60000 ? 0 : attempt + 1;
    const delay = Math.min(MAX_RESTART_DELAY_MS, 1000 * 2 ** nextAttempt);
    write(service.name, `exited with code ${code}, restarting in ${delay / 1000}s`);
    setTimeout(() => start(service, nextAttempt), delay);
  });
}

function stop() {
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

write("selfhost", `starting from ${rootDir}`);
services.forEach((service) => start(service));
