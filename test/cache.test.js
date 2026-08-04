import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { before, test } from "node:test";

import {
  CachedSnapshotError,
  cachedEnvelopeForPairing,
  restoreCachedDashboard,
} from "../src/cache.js";
import {
  ProtocolError,
  checkAcceptance,
  envelopeAad,
  importDecryptionKey,
} from "../src/protocol.js";

before(() => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});

const SHARE_ID = "ABCDEFGHIJKLMNOPQRSTUV";
const GENERATION = "11111111-1111-4111-8111-111111111111";
const OTHER_GENERATION = "22222222-2222-4222-8222-222222222222";
const CAPTURED_AT = "2026-08-04T18:00:00.000Z";
const EXPIRES_AT = "2026-08-04T20:00:00.000Z";
const LIMITS = Object.freeze({
  maxCiphertextBytes: 262_144,
  maxTtlMs: 28_800_000,
  clockSkewMs: 120_000,
});

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function dashboardPayload(capturedAt = CAPTURED_AT, expiresAt = EXPIRES_AT) {
  return {
    schema_version: 1,
    captured_at: capturedAt,
    expires_at: expiresAt,
    mode: { dry_run: false },
    snapshot: {
      rules_version: "f8ae9d9",
      run_start_pt: capturedAt,
      session: "regular",
      account: { total_value: 1508.97, cash: 1508.97, buying_power: 891.23 },
      realized_pnl_today: 21.29,
      positions: [],
    },
    runs: [],
    eras: [],
  };
}

async function encryptedFixture({
  sequence = 1,
  capturedAt = CAPTURED_AT,
  expiresAt = EXPIRES_AT,
  rawKey = null,
  ivSeed = 1,
  clear = null,
} = {}) {
  const keyBytes = rawKey || crypto.getRandomValues(new Uint8Array(32));
  const encryptionKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const decryptionKey = await importDecryptionKey(keyBytes);
  const iv = Uint8Array.from({ length: 12 }, (_, index) => (ivSeed + index) & 0xff);
  const envelope = {
    schema_version: 1,
    share_id: SHARE_ID,
    sequence,
    captured_at: capturedAt,
    expires_at: expiresAt,
    iv: base64url(iv),
    ciphertext: "pending",
  };
  const payload = clear || dashboardPayload(capturedAt, expiresAt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: envelopeAad(envelope), tagLength: 128 },
    encryptionKey,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  envelope.ciphertext = base64url(new Uint8Array(ciphertext));
  return {
    accepted: await checkAcceptance(envelope, null),
    envelope,
    key: decryptionKey,
    payload,
    rawKey: keyBytes,
  };
}

function persistentPairing(fixture, overrides = {}) {
  return {
    shareId: SHARE_ID,
    storage: "persistent",
    generation: GENERATION,
    key: fixture.key,
    accepted: fixture.accepted,
    lastVerifiedEnvelope: {
      generation: GENERATION,
      envelope: fixture.envelope,
    },
    ...overrides,
  };
}

test("a persistent cached envelope is authenticated, strictly validated, and restored", async () => {
  const fixture = await encryptedFixture();
  const restored = await restoreCachedDashboard(persistentPairing(fixture), {
    now: Date.parse(CAPTURED_AT) + 60_000,
    limits: LIMITS,
  });

  assert.deepEqual(restored.payload, fixture.payload);
  assert.deepEqual(restored.accepted, fixture.accepted);
  assert.equal(restored.envelope, fixture.envelope);
});

test("an expired cached envelope is rejected before it can be displayed", async () => {
  const fixture = await encryptedFixture();
  await assert.rejects(
    () => restoreCachedDashboard(persistentPairing(fixture), {
      now: Date.parse(EXPIRES_AT) + LIMITS.clockSkewMs + 1,
      limits: LIMITS,
    }),
    (error) => error instanceof CachedSnapshotError && error.code === "cached_snapshot_expired",
  );
});

test("a cached envelope from another pairing generation is rejected", async () => {
  const fixture = await encryptedFixture();
  const pairing = persistentPairing(fixture);
  pairing.lastVerifiedEnvelope.generation = OTHER_GENERATION;

  await assert.rejects(
    () => restoreCachedDashboard(pairing, { now: Date.parse(CAPTURED_AT), limits: LIMITS }),
    (error) => error instanceof CachedSnapshotError && error.code === "cache_generation_mismatch",
  );
});

test("a cached envelope without an atomically stored acceptance boundary is rejected", async () => {
  const fixture = await encryptedFixture();
  await assert.rejects(
    () => restoreCachedDashboard(persistentPairing(fixture, { accepted: null }), {
      now: Date.parse(CAPTURED_AT),
      limits: LIMITS,
    }),
    (error) => error instanceof CachedSnapshotError && error.code === "cache_acceptance_missing",
  );
});

test("an envelope newer than the stored acceptance boundary is not treated as verified", async () => {
  const first = await encryptedFixture({ sequence: 1 });
  const newer = await encryptedFixture({ sequence: 2, rawKey: first.rawKey, ivSeed: 21 });
  const pairing = persistentPairing(newer, { accepted: first.accepted });

  await assert.rejects(
    () => restoreCachedDashboard(pairing, { now: Date.parse(CAPTURED_AT), limits: LIMITS }),
    (error) => error instanceof CachedSnapshotError && error.code === "cache_acceptance_mismatch",
  );
});

test("same-sequence cached ciphertext equivocation is rejected", async () => {
  const acceptedFixture = await encryptedFixture({ sequence: 4, ivSeed: 1 });
  const conflicting = await encryptedFixture({
    sequence: 4,
    rawKey: acceptedFixture.rawKey,
    ivSeed: 31,
  });
  const pairing = persistentPairing(conflicting, { accepted: acceptedFixture.accepted });

  await assert.rejects(
    () => restoreCachedDashboard(pairing, { now: Date.parse(CAPTURED_AT), limits: LIMITS }),
    (error) => error instanceof ProtocolError && error.code === "equivocation",
  );
});

test("a cached envelope that fails AES-GCM authentication is rejected", async () => {
  const fixture = await encryptedFixture();
  const wrongKey = await encryptedFixture({ ivSeed: 41 });
  const pairing = persistentPairing(fixture, { key: wrongKey.key });

  await assert.rejects(
    () => restoreCachedDashboard(pairing, { now: Date.parse(CAPTURED_AT), limits: LIMITS }),
    (error) => error instanceof DOMException && error.name === "OperationError",
  );
});

test("authenticated cached plaintext still has to pass the strict payload schema", async () => {
  const fixture = await encryptedFixture({ clear: { schema_version: 1, unexpected: true } });
  await assert.rejects(
    () => restoreCachedDashboard(persistentPairing(fixture), {
      now: Date.parse(CAPTURED_AT),
      limits: LIMITS,
    }),
    (error) => error instanceof ProtocolError && error.code === "invalid_payload",
  );
});

test("session-only pairings neither create nor restore a reload cache", async () => {
  const fixture = await encryptedFixture();
  const pairing = persistentPairing(fixture, { storage: "session" });

  assert.equal(cachedEnvelopeForPairing(pairing, fixture.envelope), null);
  assert.equal(await restoreCachedDashboard(pairing, {
    now: Date.parse(CAPTURED_AT),
    limits: LIMITS,
  }), null);
});
