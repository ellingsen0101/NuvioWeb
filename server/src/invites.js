// Per-person invite codes, kept in a JSON file next to the server. Only a hash of each code is stored,
// so the file doesn't give anyone access. The file is read again when it changes, so adding or
// revoking someone takes effect without a restart, and a revoked person's sessions stop at once.
import { createHash, randomInt } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function hashCode(code) {
  return createHash("sha256").update(String(code).trim().toLowerCase()).digest("hex");
}

// About 120 bits, in lowercase groups that are easy to type on a phone.
export function generateCode() {
  const group = () => Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return [group(), group(), group(), group()].join("-");
}

export function readInvites(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(data?.invites) ? data.invites.filter((invite) => invite?.name && /^[0-9a-f]{64}$/.test(invite.hash)) : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function writeInvites(file, invites) {
  writeFileSync(file, `${JSON.stringify({ invites }, null, 2)}\n`, { mode: 0o600 });
}

export function createInviteStore(file) {
  let cached = [];
  let cachedStamp = null;

  return {
    list() {
      if (!file) return [];
      let stamp;
      try {
        const info = statSync(file);
        stamp = `${info.mtimeMs}:${info.size}`;
      } catch {
        stamp = "missing";
      }
      if (stamp !== cachedStamp) {
        cached = stamp === "missing" ? [] : readInvites(file);
        cachedStamp = stamp;
      }
      return cached;
    }
  };
}
