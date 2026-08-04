import {
  ProtocolError,
  checkAcceptance,
  decryptEnvelope,
  validateEnvelope,
} from "./protocol.js";

const CACHE_KEYS = Object.freeze(["envelope", "generation"]);
const ACCEPTANCE_KEYS = Object.freeze([
  "captured_at", "cipher_hash", "expires_at", "sequence", "share_id",
]);

function exactObject(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sameAcceptance(left, right) {
  return exactObject(left, ACCEPTANCE_KEYS) && exactObject(right, ACCEPTANCE_KEYS) &&
    ACCEPTANCE_KEYS.every((key) => left[key] === right[key]);
}

export class CachedSnapshotError extends ProtocolError {
  constructor(code, message) {
    super(code, message);
    this.name = "CachedSnapshotError";
  }
}

/**
 * Builds the value stored alongside a persistent pairing. Session fallback
 * pairings intentionally never receive a reload cache.
 */
export function cachedEnvelopeForPairing(pairing, envelope) {
  if (pairing?.storage !== "persistent") return null;
  if (typeof pairing.generation !== "string" || !pairing.generation) {
    throw new CachedSnapshotError(
      "cache_generation_missing",
      "A persistent pairing generation is required before caching a snapshot.",
    );
  }
  return { generation: pairing.generation, envelope };
}

/**
 * Replays the complete security pipeline over a persisted encrypted envelope.
 * Nothing returned by IndexedDB is trusted merely because it was stored by a
 * previous page instance.
 */
export async function restoreCachedDashboard(pairing, { now = Date.now(), limits } = {}) {
  if (!pairing || pairing.storage !== "persistent") return null;
  const cached = pairing.lastVerifiedEnvelope;
  if (cached === null || cached === undefined) return null;

  if (!exactObject(cached, CACHE_KEYS)) {
    throw new CachedSnapshotError("invalid_cached_snapshot", "The cached snapshot record is invalid.");
  }
  if (typeof pairing.generation !== "string" || cached.generation !== pairing.generation) {
    throw new CachedSnapshotError(
      "cache_generation_mismatch",
      "The cached snapshot belongs to a replaced pairing generation.",
    );
  }
  if (!pairing.accepted) {
    throw new CachedSnapshotError(
      "cache_acceptance_missing",
      "A cached snapshot cannot be restored without its replay boundary.",
    );
  }
  if (!Number.isFinite(now) || !limits || !Number.isFinite(limits.clockSkewMs)) {
    throw new CachedSnapshotError("invalid_cache_context", "The cache validation context is invalid.");
  }

  const parsed = validateEnvelope(cached.envelope, pairing.shareId, now, limits);
  if (now > parsed.expiresAtMs + limits.clockSkewMs) {
    throw new CachedSnapshotError("cached_snapshot_expired", "The cached snapshot has expired.");
  }

  // checkAcceptance recomputes the ciphertext hash and detects same-sequence
  // metadata/ciphertext equivocation. Exact equality is also required so an
  // envelope newer than the atomically stored boundary can never be rendered.
  const accepted = await checkAcceptance(cached.envelope, pairing.accepted);
  if (!sameAcceptance(accepted, pairing.accepted)) {
    throw new CachedSnapshotError(
      "cache_acceptance_mismatch",
      "The cached snapshot does not exactly match the stored replay boundary.",
    );
  }

  // AES-GCM authentication and strict payload validation are deliberately
  // repeated on every bootstrap; decrypted dashboard data is never persisted.
  const payload = await decryptEnvelope(parsed, pairing.key);
  return Object.freeze({ accepted, envelope: cached.envelope, payload });
}
