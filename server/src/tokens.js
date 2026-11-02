import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function sign(secret, body) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqual(left, right) {
  const a = createHash("sha256").update(String(left)).digest();
  const b = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(a, b);
}

// The owner's keys come from ACCESS_KEYS. Friends' invite codes come from the invite store, which only
// holds hashes. Each session records which key opened it, so removing a key ends its sessions.
export function createTokenService({ secret, accessKeys, invites = { list: () => [] }, sessionTtlMs, mediaTokenTtlMs, now = Date.now }) {
  const ownerKeys = accessKeys.map((key) => ({ id: `owner-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`, name: "Owner", key }));

  function inviteId(invite) {
    return `invite-${invite.hash.slice(0, 12)}`;
  }

  function knownIds() {
    return new Set([...ownerKeys.map((entry) => entry.id), ...invites.list().map(inviteId)]);
  }

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
    // Returns who the key belongs to, or null. Every candidate is compared so that timing doesn't
    // reveal which one matched.
    identify(candidate) {
      const text = String(candidate || "");
      const candidateHash = createHash("sha256").update(text.trim().toLowerCase()).digest("hex");
      let match = null;
      for (const entry of ownerKeys) if (safeEqual(entry.key, text) && !match) match = { id: entry.id, name: entry.name };
      for (const invite of invites.list()) if (safeEqual(invite.hash, candidateHash) && !match) match = { id: inviteId(invite), name: invite.name };
      return match;
    },
    isValidAccessKey(candidate) {
      return Boolean(this.identify(candidate));
    },
    issueSession: (who = { id: ownerKeys[0]?.id, name: "Owner" }) => issue({ typ: "session", kid: who.id, who: who.name }, sessionTtlMs),
    verifySession(token) {
      const claims = verify(token, "session");
      return claims && knownIds().has(claims.kid) ? claims : null;
    },
    // Admin rights are read from the current invite list on every check, so they can be granted
    // or taken away without anyone signing in again.
    isAdmin(claims) {
      if (!claims) return false;
      if (ownerKeys.some((entry) => entry.id === claims.kid)) return true;
      return invites.list().some((invite) => inviteId(invite) === claims.kid && invite.admin === true);
    },
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
