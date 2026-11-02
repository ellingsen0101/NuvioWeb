// Access requests: someone asks to join with their name, the owner approves or declines in the app.
// Approval creates that person's invite, so they can be removed later like anyone else. The request
// carries the Nuvio sign-in link for their device, so the owner can approve that in the same step.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { generateCode, hashCode, readInvites, writeInvites } from "./invites.js";

const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 20;
const MAX_NAME_LENGTH = 40;

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function readRequests(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(data?.requests) ? data.requests : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export class AccessError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function cleanName(value) {
  const name = String(value || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  if (!name) throw new AccessError(400, "NAME_REQUIRED", "Enter your name.");
  return name;
}

// Only a Nuvio sign-in page may be offered to the owner, so a request can't carry a phishing link.
export function cleanSignInLink(value, allowedHosts) {
  if (!value) return null;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new AccessError(400, "INVALID_LINK", "That sign-in link isn't valid.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || !allowedHosts.includes(url.hostname)) {
    throw new AccessError(400, "INVALID_LINK", "That sign-in link isn't from Nuvio.");
  }
  return url.toString();
}

export function createAccessStore({ requestsFile, invitesFile, allowedLinkHosts = ["nuvio.tv"], now = Date.now }) {
  function load() {
    const time = now();
    return readRequests(requestsFile).filter((request) => time - request.createdAt < REQUEST_TTL_MS);
  }

  function save(requests) {
    writeFileSync(requestsFile, `${JSON.stringify({ requests }, null, 2)}\n`, { mode: 0o600 });
  }

  function find(requests, id, pollToken) {
    const request = requests.find((entry) => entry.id === id);
    if (!request || (pollToken !== undefined && request.pollHash !== hashToken(pollToken))) {
      throw new AccessError(404, "REQUEST_NOT_FOUND", "This request has expired. Ask again.");
    }
    return request;
  }

  function uniqueInviteName(name) {
    const taken = new Set(readInvites(invitesFile).map((invite) => invite.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${name} ${suffix}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  return {
    create({ name, signInCode, signInLink }) {
      const requests = load();
      if (requests.filter((request) => request.status === "pending").length >= MAX_PENDING) {
        throw new AccessError(429, "TOO_MANY_REQUESTS", "Too many people are waiting already. Try again later.");
      }
      const pollToken = randomBytes(24).toString("base64url");
      const request = {
        id: randomUUID(),
        name: cleanName(name),
        signInCode: String(signInCode || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 16) || null,
        signInLink: cleanSignInLink(signInLink, allowedLinkHosts),
        pollHash: hashToken(pollToken),
        status: "pending",
        createdAt: now()
      };
      save([...requests, request]);
      return { id: request.id, pollToken };
    },

    // The person asking checks here. The first check after approval hands over their access code once.
    check(id, pollToken) {
      const requests = load();
      const request = find(requests, id, pollToken);
      const result = { status: request.status };
      if (request.status === "approved" && request.code) {
        result.code = request.code;
        result.name = request.inviteName;
        delete request.code;
        save(requests);
      }
      return result;
    },

    // A Nuvio code expires after a few minutes, so a waiting device sends a fresh one.
    updateSignIn(id, pollToken, { signInCode, signInLink }) {
      const requests = load();
      const request = find(requests, id, pollToken);
      request.signInCode = String(signInCode || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 16) || null;
      request.signInLink = cleanSignInLink(signInLink, allowedLinkHosts);
      save(requests);
    },

    listPending() {
      return load()
        .filter((request) => request.status === "pending")
        .map(({ id, name, signInCode, signInLink, createdAt }) => ({ id, name, signInCode, signInLink, createdAt }));
    },

    approve(id) {
      const requests = load();
      const request = find(requests, id);
      if (request.status !== "pending") throw new AccessError(409, "ALREADY_DECIDED", "This request was already answered.");
      const code = generateCode();
      const inviteName = uniqueInviteName(request.name);
      writeInvites(invitesFile, [...readInvites(invitesFile), { name: inviteName, hash: hashCode(code), createdAt: new Date(now()).toISOString() }]);
      Object.assign(request, { status: "approved", code, inviteName, decidedAt: now() });
      save(requests);
      return { name: inviteName, signInLink: request.signInLink };
    },

    decline(id) {
      const requests = load();
      const request = find(requests, id);
      if (request.status !== "pending") throw new AccessError(409, "ALREADY_DECIDED", "This request was already answered.");
      Object.assign(request, { status: "declined", decidedAt: now() });
      save(requests);
    },

    listPeople() {
      return readInvites(invitesFile).map(({ name, admin, createdAt }) => ({ name, admin: admin === true, createdAt }));
    },

    removePerson(name) {
      const invites = readInvites(invitesFile);
      const target = invites.find((invite) => invite.name === name);
      if (!target) throw new AccessError(404, "PERSON_NOT_FOUND", "That person isn't on the list.");
      if (target.admin) throw new AccessError(409, "CANNOT_REMOVE_OWNER", "The owner can't be removed here.");
      writeInvites(invitesFile, invites.filter((invite) => invite !== target));
    }
  };
}
