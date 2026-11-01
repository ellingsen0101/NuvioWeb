import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function sign(secret, body) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqual(left, right) {
  const a = createHash("sha256").update(String(left)).digest();
  const b = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(a, b);
}

export function createTokenService({ secret, accessKeys, sessionTtlMs, mediaTokenTtlMs, now = Date.now }) {
  function issue(claims, ttlMs) {
    const exp = now() + ttlMs;
    const body = Buffer.from(JSON.stringify({ ...claims, exp, n: randomBytes(6).toString("base64url") })).toString("base64url");
    return { token: `${body}.${sign(secret, body)}`, expiresAt: exp };
  }

  function verify(token, expectedType) {
    const [body, signature, extra] = String(token || "").split(".");
    if (!body || !signature || extra !== undefined) return null;
    if (!safeEqual(sign(secret, body), signature)) return null;
    let claims;
    try {
      claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (claims?.typ !== expectedType || !(claims.exp > now())) return null;
    return claims;
  }

  return {
    isValidAccessKey(candidate) {
      // Every key is compared so that timing doesn't reveal which one matched.
      return accessKeys.map((key) => safeEqual(key, candidate)).some(Boolean);
    },
    issueSession: () => issue({ typ: "session" }, sessionTtlMs),
    verifySession: (token) => verify(token, "session"),
    // Media tokens work in URLs because <video> can't send headers, so each one is tied to a
    // single playback session and expires. A leaked URL exposes that one stream only.
    issueMedia: (playbackId) => issue({ typ: "media", pid: playbackId }, mediaTokenTtlMs).token,
    verifyMedia(token, playbackId) {
      const claims = verify(token, "media");
      return Boolean(claims && claims.pid === playbackId);
    }
  };
}

export function createRateLimiter({ now = Date.now } = {}) {
  const buckets = new Map();
  return {
    // Fixed window per key. Returns false once the limit for the window is used up.
    allow(key, limit, windowMs) {
      const time = now();
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= time) {
        bucket = { count: 0, resetAt: time + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      if (buckets.size > 10000) {
        for (const [entryKey, entry] of buckets) if (entry.resetAt <= time) buckets.delete(entryKey);
      }
      return bucket.count <= limit;
    },
    // Checks the window without counting a new attempt.
    isExhausted(key, limit) {
      const bucket = buckets.get(key);
      return Boolean(bucket && bucket.resetAt > now() && bucket.count >= limit);
    }
  };
}
