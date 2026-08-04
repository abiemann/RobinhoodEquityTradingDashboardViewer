export const ENVELOPE_SCHEMA_VERSION = 1;
export const PAIRING_VERSION = "2";
export const PROVIDER = "gdrive";
export const SHARE_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ENVELOPE_KEYS = Object.freeze([
  "captured_at", "ciphertext", "expires_at", "iv", "schema_version", "sequence", "share_id",
]);
const PAYLOAD_KEYS = Object.freeze([
  "schema_version", "captured_at", "expires_at", "mode", "snapshot", "runs", "eras",
]);
const ENHANCED_PAYLOAD_KEYS = Object.freeze([...PAYLOAD_KEYS, "pnl_reconciliation"]);
const ERA_KEYS = Object.freeze([
  "rules_version", "first", "last", "buys", "sells", "stops", "realized_pnl",
]);
const ENHANCED_ERA_KEYS = Object.freeze([...ERA_KEYS, "realized_pnl_cents", "pnl_quality"]);
const PNL_RECONCILIATION_KEYS = Object.freeze([
  "date_et", "broker_realized_pnl_cents", "strategy_realized_pnl_cents", "difference_cents",
  "realized_fill_count", "available_fill_count", "matched_fill_count", "status",
]);
const PNL_QUALITIES = new Set(["matched-ledger-pool", "estimated", "incomplete"]);
const PNL_RECONCILIATION_STATUSES = new Set(["agrees", "difference", "qualified"]);

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function exactObject(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.length <= maximum;
}

function safeInteger(value, { nonnegative = false } = {}) {
  return Number.isSafeInteger(value) && (!nonnegative || value >= 0);
}

function moneyCents(value) {
  if (!finite(value)) return null;
  const absolute = Math.round(Math.abs(value) * 100);
  if (!Number.isSafeInteger(absolute)) return null;
  return value < 0 ? -absolute : absolute;
}

function canonicalDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const millis = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value;
}

export function canonicalTimestamp(value, field = "timestamp") {
  if (typeof value !== "string" || !ISO_UTC_RE.test(value)) {
    throw new ProtocolError(`invalid_${field}`, `${field} must be a canonical UTC timestamp.`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new ProtocolError(`invalid_${field}`, `${field} is not a valid timestamp.`);
  }
  return millis;
}

export function decodeBase64Url(value, field = "value") {
  if (typeof value !== "string" || !BASE64URL_RE.test(value) || value.length % 4 === 1) {
    throw new ProtocolError(`invalid_${field}`, `${field} must be unpadded base64url.`);
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new ProtocolError(`invalid_${field}`, `${field} must be unpadded base64url.`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function parsePairingHash(hash) {
  if (typeof hash !== "string" || !hash.startsWith("#") || hash.length <= 1) {
    throw new ProtocolError("missing_pairing", "The pairing link is missing.");
  }
  const params = new URLSearchParams(hash.slice(1));
  const keys = [...params.keys()].sort();
  const expected = ["id", "key", "provider", "v"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new ProtocolError("invalid_pairing", "The pairing link has missing, duplicate, or unexpected fields.");
  }
  const version = params.get("v");
  const provider = params.get("provider");
  const shareId = params.get("id") || "";
  const keyText = params.get("key") || "";
  if (version !== PAIRING_VERSION || provider !== PROVIDER || !SHARE_ID_RE.test(shareId)) {
    throw new ProtocolError("invalid_pairing", "The pairing link is unsupported or invalid.");
  }
  const keyBytes = decodeBase64Url(keyText, "key");
  if (keyBytes.byteLength !== 32) {
    keyBytes.fill(0);
    throw new ProtocolError("invalid_key", "The pairing key must be 32 bytes.");
  }
  return Object.freeze({ version, provider, shareId, keyText, keyBytes });
}

export async function importDecryptionKey(rawBytes) {
  if (!(rawBytes instanceof Uint8Array) || rawBytes.byteLength !== 32) {
    throw new ProtocolError("invalid_key", "The pairing key must be 32 bytes.");
  }
  return crypto.subtle.importKey("raw", rawBytes, { name: "AES-GCM" }, false, ["decrypt"]);
}

export function validateEnvelope(value, expectedShareId, now, limits) {
  if (!exactObject(value, ENVELOPE_KEYS) || value.schema_version !== ENVELOPE_SCHEMA_VERSION ||
      value.share_id !== expectedShareId || !SHARE_ID_RE.test(expectedShareId) ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new ProtocolError("invalid_envelope", "The encrypted envelope is invalid.");
  }

  const capturedAtMs = canonicalTimestamp(value.captured_at, "captured_at");
  const expiresAtMs = canonicalTimestamp(value.expires_at, "expires_at");
  if (expiresAtMs <= capturedAtMs || expiresAtMs - capturedAtMs > limits.maxTtlMs ||
      capturedAtMs > now + limits.clockSkewMs) {
    throw new ProtocolError("invalid_timestamps", "The encrypted envelope timestamps are invalid.");
  }

  const iv = decodeBase64Url(value.iv, "iv");
  const ciphertext = decodeBase64Url(value.ciphertext, "ciphertext");
  if (iv.byteLength !== 12 || ciphertext.byteLength < 16 || ciphertext.byteLength > limits.maxCiphertextBytes) {
    throw new ProtocolError("invalid_ciphertext", "The encrypted payload size is invalid.");
  }

  return Object.freeze({ value, capturedAtMs, expiresAtMs, iv, ciphertext });
}

export function validatePayload(value, envelope) {
  const legacyPayload = exactObject(value, PAYLOAD_KEYS);
  const enhancedPayload = exactObject(value, ENHANCED_PAYLOAD_KEYS);
  if ((!legacyPayload && !enhancedPayload) || value.schema_version !== ENVELOPE_SCHEMA_VERSION ||
      value.captured_at !== envelope.captured_at || value.expires_at !== envelope.expires_at ||
      !exactObject(value.mode, ["dry_run"]) || typeof value.mode.dry_run !== "boolean") {
    throw new ProtocolError("invalid_payload", "The decrypted snapshot schema is invalid.");
  }

  const snapshot = value.snapshot;
  const snapshotKeys = ["rules_version", "run_start_pt", "session", "account", "realized_pnl_today", "positions"];
  if (!exactObject(snapshot, snapshotKeys) || !boundedText(snapshot.rules_version, 128) ||
      !boundedText(snapshot.run_start_pt, 64) || !Number.isFinite(Date.parse(snapshot.run_start_pt)) ||
      Date.parse(snapshot.run_start_pt) > Date.parse(value.captured_at) + 120_000 ||
      !boundedText(snapshot.session, 32) || !finite(snapshot.realized_pnl_today) ||
      !exactObject(snapshot.account, ["total_value", "cash", "buying_power"]) ||
      ![snapshot.account.total_value, snapshot.account.cash, snapshot.account.buying_power].every(finite) ||
      !Array.isArray(snapshot.positions) || snapshot.positions.length > 100) {
    throw new ProtocolError("invalid_snapshot", "The decrypted snapshot fields are invalid.");
  }

  for (const position of snapshot.positions) {
    const fields = ["symbol", "quantity", "avg_buy_price", "current_price", "stop_price", "stop_state"];
    if (!exactObject(position, fields) || typeof position.symbol !== "string" ||
        !/^[A-Z0-9.-]{1,12}$/.test(position.symbol) || !finite(position.quantity) || position.quantity < 0 ||
        !finite(position.avg_buy_price) || position.avg_buy_price < 0 ||
        !finite(position.current_price) || position.current_price < 0 ||
        !(position.stop_price === null || (finite(position.stop_price) && position.stop_price >= 0)) ||
        !boundedText(position.stop_state, 32)) {
      throw new ProtocolError("invalid_position", "A decrypted position is invalid.");
    }
  }

  if (!Array.isArray(value.runs) || value.runs.length > 100) {
    throw new ProtocolError("invalid_runs", "The decrypted runs are invalid.");
  }
  for (const run of value.runs) {
    if (!exactObject(run, ["time", "label", "phase", "tooltip"]) || !boundedText(run.time, 32) ||
        !boundedText(run.label, 80) || !boundedText(run.phase, 32) || !boundedText(run.tooltip, 500)) {
      throw new ProtocolError("invalid_run", "A decrypted run is invalid.");
    }
  }

  if (!Array.isArray(value.eras) || value.eras.length > 500) {
    throw new ProtocolError("invalid_eras", "The decrypted rules eras are invalid.");
  }
  for (const era of value.eras) {
    const keysValid = enhancedPayload
      ? exactObject(era, ENHANCED_ERA_KEYS)
      : exactObject(era, ERA_KEYS);
    if (!keysValid ||
        !boundedText(era.rules_version, 128) || !boundedText(era.first, 16) || !boundedText(era.last, 16) ||
        ![era.buys, era.sells, era.stops].every((number) => safeInteger(number, { nonnegative: true })) ||
        !finite(era.realized_pnl)) {
      throw new ProtocolError("invalid_era", "A decrypted rules era is invalid.");
    }
    if (enhancedPayload &&
        (!safeInteger(era.realized_pnl_cents) || moneyCents(era.realized_pnl) !== era.realized_pnl_cents ||
         !PNL_QUALITIES.has(era.pnl_quality) ||
         (era.pnl_quality !== "matched-ledger-pool" && era.sells === 0))) {
      throw new ProtocolError("invalid_era", "A decrypted rules era has invalid P&L attribution.");
    }
  }

  if (enhancedPayload) {
    const reconciliation = value.pnl_reconciliation;
    const cents = [
      reconciliation?.broker_realized_pnl_cents,
      reconciliation?.strategy_realized_pnl_cents,
      reconciliation?.difference_cents,
    ];
    const counts = [
      reconciliation?.realized_fill_count,
      reconciliation?.available_fill_count,
      reconciliation?.matched_fill_count,
    ];
    const allMatched = reconciliation?.matched_fill_count === reconciliation?.realized_fill_count;
    const expectedStatus = !allMatched
      ? "qualified"
      : reconciliation?.difference_cents === 0 ? "agrees" : "difference";
    if (!exactObject(reconciliation, PNL_RECONCILIATION_KEYS) ||
        !canonicalDate(reconciliation.date_et) ||
        !cents.every((number) => safeInteger(number)) ||
        !counts.every((number) => safeInteger(number, { nonnegative: true })) ||
        reconciliation.matched_fill_count > reconciliation.available_fill_count ||
        reconciliation.available_fill_count > reconciliation.realized_fill_count ||
        reconciliation.broker_realized_pnl_cents !== moneyCents(snapshot.realized_pnl_today) ||
        reconciliation.difference_cents !==
          reconciliation.broker_realized_pnl_cents - reconciliation.strategy_realized_pnl_cents ||
        !PNL_RECONCILIATION_STATUSES.has(reconciliation.status) ||
        reconciliation.status !== expectedStatus) {
      throw new ProtocolError("invalid_pnl_reconciliation", "The P&L comparison is invalid.");
    }
  }
  return value;
}

export function envelopeAad(envelope) {
  return new TextEncoder().encode(JSON.stringify([
    envelope.schema_version, envelope.share_id, envelope.sequence, envelope.captured_at, envelope.expires_at,
  ]));
}

async function cipherHash(envelope) {
  const bytes = new TextEncoder().encode(`${envelope.iv}.${envelope.ciphertext}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function checkAcceptance(envelope, previous) {
  const hash = await cipherHash(envelope);
  if (previous) {
    if (previous.share_id !== envelope.share_id) {
      throw new ProtocolError("share_mismatch", "The stored acceptance belongs to another share.");
    }
    if (envelope.sequence < previous.sequence) {
      throw new ProtocolError("rollback", "A rolled-back snapshot was rejected.");
    }
    if (envelope.sequence === previous.sequence &&
        (envelope.captured_at !== previous.captured_at || envelope.expires_at !== previous.expires_at ||
         hash !== previous.cipher_hash)) {
      throw new ProtocolError("equivocation", "Conflicting snapshots with the same sequence were rejected.");
    }
    if (envelope.sequence > previous.sequence && Date.parse(envelope.captured_at) < Date.parse(previous.captured_at)) {
      throw new ProtocolError("capture_rollback", "A snapshot with an older capture time was rejected.");
    }
    // A later sequence may extend expiry so one pairing survives future laptop
    // sessions. Same-sequence expiry changes are already rejected as equivocation.
  }
  return Object.freeze({
    share_id: envelope.share_id,
    sequence: envelope.sequence,
    captured_at: envelope.captured_at,
    expires_at: envelope.expires_at,
    cipher_hash: hash,
  });
}

export async function decryptEnvelope(parsedEnvelope, key) {
  const clearBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: parsedEnvelope.iv, additionalData: envelopeAad(parsedEnvelope.value), tagLength: 128 },
    key,
    parsedEnvelope.ciphertext,
  );
  let clearText;
  try {
    clearText = new TextDecoder("utf-8", { fatal: true }).decode(clearBytes);
  } catch {
    throw new ProtocolError("invalid_utf8", "The decrypted snapshot is not valid UTF-8.");
  }
  let payload;
  try {
    payload = JSON.parse(clearText);
  } catch {
    throw new ProtocolError("invalid_json", "The decrypted snapshot is not valid JSON.");
  }
  return validatePayload(payload, parsedEnvelope.value);
}
