// Starts the backend for local development with values from server/.env (never committed).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(serverDir, ".env");

if (!existsSync(envPath)) {
  writeFileSync(
    envPath,
    [
      `ACCESS_KEYS=${randomBytes(24).toString("base64url")}`,
      `TOKEN_SECRET=${randomBytes(48).toString("base64url")}`,
      "ALLOWED_ORIGINS=http://localhost:5173",
      ""
    ].join("\n")
  );
  console.log(`Created ${envPath} with new local secrets.`);
}
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
}
await import("../src/index.js");
