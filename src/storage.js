const DATABASE_NAME = "rhmra-phone-v2";
const DATABASE_VERSION = 1;
const STORE_NAME = "pairings";
const SESSION_KEY = "rhmra.phone.v2.fallback";
const ACCEPTANCE_KEYS = Object.freeze([
  "captured_at", "cipher_hash", "expires_at", "sequence", "share_id",
]);
const SHARE_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
const GENERATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

export class PairingStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PairingStateError";
    this.code = code;
  }
}

function exactObject(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validAcceptance(value) {
  return exactObject(value, ACCEPTANCE_KEYS) && SHARE_ID_RE.test(value.share_id) &&
    Number.isSafeInteger(value.sequence) && value.sequence >= 1 &&
    Number.isFinite(Date.parse(value.captured_at)) && Number.isFinite(Date.parse(value.expires_at)) &&
    HASH_RE.test(value.cipher_hash);
}

function newGeneration() {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("Secure random UUID generation is unavailable.");
  }
  return crypto.randomUUID();
}

function requirePairingKey(key) {
  if (!key || key.extractable !== false || key.type !== "secret") {
    throw new Error("A non-extractable CryptoKey is required.");
  }
}

export function mergeAcceptance(current, proposed, shareId) {
  if (current !== null && current !== undefined && !validAcceptance(current)) {
    throw new PairingStateError("invalid_stored_acceptance", "The stored replay boundary is invalid.");
  }
  if (proposed === undefined) return current || null;
  if (proposed === null) {
    if (current) {
      throw new PairingStateError("acceptance_regression", "The replay boundary cannot be cleared.");
    }
    return null;
  }
  if (!validAcceptance(proposed) || proposed.share_id !== shareId) {
    throw new PairingStateError("invalid_acceptance", "The proposed replay boundary is invalid.");
  }
  if (!current) return proposed;
  if (current.share_id !== shareId) {
    throw new PairingStateError("share_mismatch", "The stored replay boundary belongs to another share.");
  }
  if (proposed.sequence < current.sequence) {
    throw new PairingStateError("acceptance_regression", "A stale tab cannot lower the replay boundary.");
  }
  if (proposed.sequence === current.sequence) {
    if (proposed.captured_at !== current.captured_at || proposed.expires_at !== current.expires_at ||
        proposed.cipher_hash !== current.cipher_hash) {
      throw new PairingStateError("acceptance_equivocation", "Conflicting replay boundaries were rejected.");
    }
    return current;
  }
  if (Date.parse(proposed.captured_at) < Date.parse(current.captured_at)) {
    throw new PairingStateError("capture_regression", "A stale tab cannot move capture time backward.");
  }
  return proposed;
}

export function mergePairingUpdate(current, expected, updates) {
  if (!current || current.shareId !== expected?.shareId) {
    throw new PairingStateError("pairing_missing", "The pairing was removed in another tab.");
  }
  if (!GENERATION_RE.test(current.generation || "") || current.generation !== expected.generation) {
    throw new PairingStateError("pairing_changed", "The pairing changed in another tab.");
  }
  requirePairingKey(current.key);
  return {
    ...current,
    ...updates,
    shareId: current.shareId,
    provider: current.provider,
    generation: current.generation,
    key: current.key,
    accepted: mergeAcceptance(current.accepted || null, updates.accepted, current.shareId),
  };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("IndexedDB request failed.")), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error || new Error("IndexedDB transaction aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error || new Error("IndexedDB transaction failed.")), { once: true });
  });
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("IndexedDB is unavailable."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "shareId" });
      }
    }, { once: true });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("IndexedDB could not be opened.")), { once: true });
    request.addEventListener("blocked", () => reject(new Error("IndexedDB upgrade was blocked.")), { once: true });
  });
}

async function withStore(mode, operation) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const done = transactionDone(transaction);
    const result = await operation(transaction.objectStore(STORE_NAME));
    await done;
    return result;
  } finally {
    database.close();
  }
}

export async function savePairing(pairing) {
  requirePairingKey(pairing?.key);
  const record = {
    shareId: pairing.shareId,
    provider: pairing.provider,
    generation: GENERATION_RE.test(pairing.generation || "") ? pairing.generation : newGeneration(),
    key: pairing.key,
    accepted: pairing.accepted || null,
    driveFileId: pairing.driveFileId || null,
    pairedAt: pairing.pairedAt || Date.now(),
  };
  await withStore("readwrite", (store) => requestResult(store.put(record)));
  const readBack = await loadPairing(record.shareId);
  if (!readBack?.key || readBack.key.extractable !== false || readBack.key.type !== "secret") {
    throw new Error("This browser cannot safely persist a non-extractable CryptoKey.");
  }
  return readBack;
}

export async function loadPairing(shareId) {
  return withStore("readonly", (store) => requestResult(store.get(shareId)));
}

export async function loadLatestPairing() {
  const records = await withStore("readonly", (store) => requestResult(store.getAll()));
  if (!Array.isArray(records) || records.length === 0) return null;
  records.sort((left, right) => Number(right.pairedAt || 0) - Number(left.pairedAt || 0));
  return records[0];
}

export async function updatePairing(pairing, updates) {
  return withStore("readwrite", async (store) => {
    const current = await requestResult(store.get(pairing.shareId));
    const next = mergePairingUpdate(current, pairing, updates);
    await requestResult(store.put(next));
    return next;
  });
}

export async function clearPairings() {
  try {
    await withStore("readwrite", (store) => requestResult(store.clear()));
  } finally {
    clearSessionFallback();
  }
}

export function saveSessionFallback({ shareId, provider, keyText, accepted = null, driveFileId = null }) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    shareId, provider, keyText, accepted, driveFileId, pairedAt: Date.now(),
  }));
}

export function loadSessionFallback() {
  try {
    const record = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (!record || typeof record.shareId !== "string" || typeof record.provider !== "string" ||
        typeof record.keyText !== "string") return null;
    return record;
  } catch {
    return null;
  }
}

export function updateSessionFallback(updates) {
  const record = loadSessionFallback();
  if (!record) return null;
  const next = { ...record, ...updates };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
  return next;
}

export function clearSessionFallback() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // A blocked session store contains nothing useful to clear.
  }
}
