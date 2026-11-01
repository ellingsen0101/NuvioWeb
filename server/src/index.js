import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error.message);
  console.error("See server/.env.example for the required settings.");
  process.exit(1);
}
config.publicBaseUrl = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, "") : null;

const app = await createApp(config);
const port = await app.listen();
console.log(`Nuvio Web backend listening on ${config.host}:${port}`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received. Cleaning up.`);
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  await app.close().catch((error) => console.error(error.message));
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
