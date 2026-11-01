// SSRF protection for every outbound request made for a client. The check runs inside the socket's
// DNS lookup, so the address that gets connected to is the address that was checked. That closes
// DNS rebinding, and each redirect hop goes through the same check.
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const blocked = new net.BlockList();
const V4_RANGES = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
];
const V6_RANGES = [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
];
V4_RANGES.forEach(([address, prefix]) => blocked.addSubnet(address, prefix, "ipv4"));
V6_RANGES.forEach(([address, prefix]) => blocked.addSubnet(address, prefix, "ipv6"));

export const PRIVATE_PEER_RANGES = V4_RANGES.map(([address, prefix]) => `${address}/${prefix}`);

export class UpstreamError extends Error {
  constructor(message, code = "UPSTREAM_ERROR") {
    super(message);
    this.name = "UpstreamError";
    this.code = code;
  }
}

export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;
  const text = String(address).toLowerCase();
  // ::ffff:127.0.0.1 and similar forms reach IPv4 hosts, so they get the IPv4 rules.
  const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return blocked.check(mapped[1], "ipv4");
  return blocked.check(text, family === 6 ? "ipv6" : "ipv4");
}

function guardedLookup(allowPrivate) {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options?.family || 4 }];
      if (!allowPrivate && list.some((entry) => isBlockedAddress(entry.address))) {
        return callback(new UpstreamError("That address isn't allowed", "BLOCKED_ADDRESS"));
      }
      if (options?.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

export function parsePublicUrl(value, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new UpstreamError("That isn't a valid URL", "INVALID_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UpstreamError("Only http and https URLs are allowed", "INVALID_URL");
  }
  if (url.username || url.password) throw new UpstreamError("URLs can't include credentials", "INVALID_URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate) {
    if (net.isIP(host) && isBlockedAddress(host)) throw new UpstreamError("That address isn't allowed", "BLOCKED_ADDRESS");
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
      throw new UpstreamError("That address isn't allowed", "BLOCKED_ADDRESS");
    }
  }
  return url;
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "host", "connection", "content-length", "transfer-encoding", "upgrade", "te", "trailer",
  "proxy-authorization", "proxy-connection", "keep-alive", "forwarded", "x-forwarded-for",
  "x-forwarded-host", "x-real-ip"
]);

export function sanitizeUpstreamHeaders(headers) {
  const result = {};
  if (!headers || typeof headers !== "object") return result;
  for (const [name, value] of Object.entries(headers)) {
    const key = String(name).toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(key) || typeof value !== "string") continue;
    if (!/^[a-z0-9-]+$/.test(key) || /[\r\n]/.test(value)) continue;
    result[key] = value;
  }
  return result;
}

const MAX_REDIRECTS = 5;

// GET only. Resolves with the response stream once the final response headers have arrived.
export function safeGet(rawUrl, { headers = {}, timeoutMs = 15000, allowPrivate = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    const hop = (current, remaining) => {
      let url;
      try {
        url = parsePublicUrl(current, { allowPrivate });
      } catch (error) {
        reject(error);
        return;
      }
      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request(
        url,
        {
          method: "GET",
          headers: { "user-agent": "NuvioWeb/1.0", ...sanitizeUpstreamHeaders(headers) },
          lookup: guardedLookup(allowPrivate),
          signal
        },
        (response) => {
          const status = response.statusCode || 0;
          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            if (remaining <= 0) {
              reject(new UpstreamError("Too many redirects", "TOO_MANY_REDIRECTS"));
              return;
            }
            hop(new URL(response.headers.location, url).toString(), remaining - 1);
            return;
          }
          request.setTimeout(0);
          response.finalUrl = url.toString();
          resolve(response);
        }
      );
      request.setTimeout(timeoutMs, () => {
        request.destroy(new UpstreamError("The upstream server timed out", "UPSTREAM_TIMEOUT"));
      });
      request.on("error", (error) => {
        reject(error instanceof UpstreamError ? error : Object.assign(new UpstreamError("The upstream server couldn't be reached"), { cause: error }));
      });
      request.end();
    };
    hop(rawUrl, MAX_REDIRECTS);
  });
}

export async function safeGetText(url, { maxBytes, ...options } = {}) {
  const response = await safeGet(url, options);
  const status = response.statusCode || 0;
  if (status < 200 || status >= 300) {
    response.resume();
    throw new UpstreamError(`The upstream server answered ${status}`, "UPSTREAM_STATUS");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response) {
    total += chunk.length;
    if (total > maxBytes) {
      response.destroy();
      throw new UpstreamError("The upstream response is too large", "UPSTREAM_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
