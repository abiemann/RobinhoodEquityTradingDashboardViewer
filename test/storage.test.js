import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPersistentPairingRecord,
  PairingStateError,
  mergeAcceptance,
  mergeConditionalEnvelopeClear,
  mergePairingUpdate,
} from "../src/storage.js";

const SHARE_ID = "ABCDEFGHIJKLMNOPQRSTUV";
const OTHER_SHARE_ID = "QRSTUVWXYZabcdefghijkl";
const GENERATION = "11111111-1111-4111-8111-111111111111";
const OTHER_GENERATION = "22222222-2222-4222-8222-222222222222";
const KEY = Object.freeze({ type: "secret", extractable: false });
const IV = "AQIDBAUGBwgJCgsM";
const CIPHERTEXT = "AAECAwQFBgcICQoLDA0ODw";

function acceptance(
  sequence,
  capturedAt = "2026-08-03T" + String(sequence + 10).padStart(2, "0") + ":00:00.000Z",
  suffix = "a",
) {
  return Object.freeze({
    share_id: SHARE_ID,
    sequence,
    captured_at: capturedAt,
    expires_at: "2026-08-03T" + String(sequence + 12).padStart(2, "0") + ":00:00.000Z",
    cipher_hash: suffix.repeat(64),
  });
}

function encryptedEnvelope(accepted, overrides = {}) {
  return {
    schema_version: 1,
    share_id: accepted.share_id,
    sequence: accepted.sequence,
    captured_at: accepted.captured_at,
    expires_at: accepted.expires_at,
    iv: IV,
    ciphertext: CIPHERTEXT,
    ...overrides,
  };
}

function cachedEnvelope(accepted, {
  generation = GENERATION,
  envelopeOverrides = {},
  extra = {},
} = {}) {
  return {
    generation,
    envelope: encryptedEnvelope(accepted, envelopeOverrides),
    ...extra,
  };
}

function record({
  accepted = acceptance(2),
  lastVerifiedEnvelope,
  generation = GENERATION,
} = {}) {
  return {
    shareId: SHARE_ID,
    provider: "gdrive",
    generation,
    key: KEY,
    accepted,
    driveFileId: "old-file",
    pairedAt: 1,
    lastVerifiedEnvelope: lastVerifiedEnvelope === undefined
      ? cachedEnvelope(accepted, { generation })
      : lastVerifiedEnvelope,
  };
}

function assertPairingError(code) {
  return (error) => error instanceof PairingStateError && error.code === code;
}

test("accepted boundary, encrypted envelope, and Drive metadata advance atomically", () => {
  const current = record();
  const nextAcceptance = acceptance(3);
  const nextEnvelope = cachedEnvelope(nextAcceptance);
  const advanced = mergePairingUpdate(current, current, {
    accepted: nextAcceptance,
    driveFileId: "new-file",
    lastVerifiedEnvelope: nextEnvelope,
  });

  assert.equal(advanced.accepted, nextAcceptance);
  assert.equal(advanced.lastVerifiedEnvelope, nextEnvelope);
  assert.equal(advanced.driveFileId, "new-file");
  assert.equal(advanced.generation, GENERATION);
  assert.equal(advanced.key, KEY);
  assert.deepEqual(Object.keys(advanced.lastVerifiedEnvelope).sort(), ["envelope", "generation"]);
  assert.deepEqual(Object.keys(advanced.lastVerifiedEnvelope.envelope).sort(), [
    "captured_at", "ciphertext", "expires_at", "iv", "schema_version", "sequence", "share_id",
  ]);
  assert.equal(Object.hasOwn(advanced.lastVerifiedEnvelope, "payload"), false);

  const metadataOnly = mergePairingUpdate(advanced, advanced, { driveFileId: "replacement-file" });
  assert.equal(metadataOnly.accepted, nextAcceptance);
  assert.equal(metadataOnly.lastVerifiedEnvelope, nextEnvelope);
  assert.equal(metadataOnly.driveFileId, "replacement-file");
});

test("pairing updates reject arbitrary fields and plaintext-shaped cache additions", () => {
  const current = record();
  assert.throws(
    () => mergePairingUpdate(current, current, { payload: { account: "plaintext" } }),
    assertPairingError("invalid_pairing_update"),
  );
  assert.throws(
    () => mergePairingUpdate(current, current, {
      lastVerifiedEnvelope: cachedEnvelope(current.accepted, {
        extra: { payload: { account: "plaintext" } },
      }),
    }),
    assertPairingError("invalid_last_verified_envelope"),
  );
  assert.throws(
    () => mergePairingUpdate(current, current, {
      lastVerifiedEnvelope: cachedEnvelope(current.accepted, {
        envelopeOverrides: { payload: { account: "plaintext" } },
      }),
    }),
    assertPairingError("invalid_last_verified_envelope"),
  );

  const injectedLegacy = { ...current, payload: { account: "plaintext" } };
  const cleaned = mergePairingUpdate(injectedLegacy, injectedLegacy, { driveFileId: "clean-file" });
  assert.equal(Object.hasOwn(cleaned, "payload"), false);
});

test("cached envelopes are bound to the active pairing generation", () => {
  const current = record();
  const nextAcceptance = acceptance(3);
  assert.throws(
    () => mergePairingUpdate(current, current, {
      accepted: nextAcceptance,
      lastVerifiedEnvelope: cachedEnvelope(nextAcceptance, { generation: OTHER_GENERATION }),
    }),
    assertPairingError("invalid_last_verified_envelope"),
  );

  const corruptStored = record({
    lastVerifiedEnvelope: cachedEnvelope(acceptance(2), { generation: OTHER_GENERATION }),
  });
  assert.throws(
    () => mergePairingUpdate(corruptStored, corruptStored, { driveFileId: "new-file" }),
    assertPairingError("invalid_stored_envelope"),
  );
});

test("cached envelope metadata and encodings must exactly match the merged acceptance", () => {
  const current = record();
  const nextAcceptance = acceptance(3);
  const invalidOverrides = [
    { schema_version: 2 },
    { share_id: OTHER_SHARE_ID },
    { sequence: nextAcceptance.sequence + 1 },
    { captured_at: "2026-08-03T13:00:01.000Z" },
    { expires_at: "2026-08-03T15:00:01.000Z" },
    { captured_at: "2026-08-03 13:00:00Z" },
    { iv: "not=padded" },
    { iv: "AQID" },
    { ciphertext: "*" },
    { ciphertext: "AQID" },
  ];

  for (const envelopeOverrides of invalidOverrides) {
    assert.throws(
      () => mergePairingUpdate(current, current, {
        accepted: nextAcceptance,
        lastVerifiedEnvelope: cachedEnvelope(nextAcceptance, { envelopeOverrides }),
      }),
      assertPairingError("invalid_last_verified_envelope"),
    );
  }
});

test("an acceptance update cannot commit without its encrypted envelope", () => {
  const current = record();
  const nextAcceptance = acceptance(3);
  assert.throws(
    () => mergePairingUpdate(current, current, { accepted: nextAcceptance }),
    assertPairingError("acceptance_requires_envelope"),
  );
  assert.throws(
    () => mergePairingUpdate(current, current, {
      accepted: nextAcceptance,
      lastVerifiedEnvelope: null,
    }),
    assertPairingError("acceptance_requires_envelope"),
  );
});

test("a stale tab cannot regress or equivocate the replay boundary", () => {
  assert.throws(
    () => mergeAcceptance(acceptance(3), acceptance(2), SHARE_ID),
    assertPairingError("acceptance_regression"),
  );
  assert.throws(
    () => mergeAcceptance(acceptance(2), acceptance(2, "2026-08-03T12:00:00.000Z", "b"), SHARE_ID),
    assertPairingError("acceptance_equivocation"),
  );
  assert.throws(
    () => mergeAcceptance(acceptance(3), acceptance(4, "2026-08-03T12:59:59.000Z"), SHARE_ID),
    assertPairingError("capture_regression"),
  );
});

test("a tab from a replaced pairing generation cannot write cache or metadata", () => {
  const current = record();
  const stale = { ...current, generation: OTHER_GENERATION };
  assert.throws(
    () => mergePairingUpdate(current, stale, { driveFileId: null }),
    assertPairingError("pairing_changed"),
  );
  assert.throws(
    () => mergePairingUpdate(current, stale, {
      accepted: acceptance(3),
      lastVerifiedEnvelope: cachedEnvelope(acceptance(3), { generation: OTHER_GENERATION }),
    }),
    assertPairingError("pairing_changed"),
  );
});

test("legacy accepted records without a cache remain usable and can upgrade atomically", () => {
  const legacy = record();
  delete legacy.lastVerifiedEnvelope;

  const metadataOnly = mergePairingUpdate(legacy, legacy, { driveFileId: "replacement-file" });
  assert.equal(metadataOnly.accepted, legacy.accepted);
  assert.equal(metadataOnly.lastVerifiedEnvelope, null);
  assert.equal(metadataOnly.driveFileId, "replacement-file");

  const nextAcceptance = acceptance(3);
  const upgraded = mergePairingUpdate(metadataOnly, metadataOnly, {
    accepted: nextAcceptance,
    lastVerifiedEnvelope: cachedEnvelope(nextAcceptance),
  });
  assert.equal(upgraded.accepted, nextAcceptance);
  assert.equal(upgraded.lastVerifiedEnvelope.envelope.sequence, 3);
});

test("saving or re-pairing creates a record without inheriting an old cached envelope", () => {
  const prior = record();
  const fresh = createPersistentPairingRecord({
    ...prior,
    lastVerifiedEnvelope: prior.lastVerifiedEnvelope,
    pairedAt: 0,
  }, 1234);

  assert.equal(fresh.lastVerifiedEnvelope, null);
  assert.equal(fresh.accepted, prior.accepted);
  assert.equal(fresh.generation, GENERATION);
  assert.equal(fresh.pairedAt, 1234);
});

test("conditional expiry clear preserves the replay boundary and clears only the matching cache", () => {
  const current = record();
  const result = mergeConditionalEnvelopeClear(current, current, current.accepted);

  assert.equal(result.cleared, true);
  assert.equal(result.pairing.accepted, current.accepted);
  assert.equal(result.pairing.lastVerifiedEnvelope, null);
  assert.equal(result.pairing.driveFileId, current.driveFileId);
  assert.equal(result.pairing.generation, current.generation);
});

test("an exact-bound clear sanitizes a corrupt plaintext-shaped cache", () => {
  const current = {
    ...record({ lastVerifiedEnvelope: { payload: { account: "plaintext" } } }),
    payload: { account: "plaintext" },
    unexpected: true,
  };

  const result = mergeConditionalEnvelopeClear(current, current, current.accepted);

  assert.equal(result.cleared, true);
  assert.equal(result.pairing.accepted, current.accepted);
  assert.equal(result.pairing.lastVerifiedEnvelope, null);
  assert.deepEqual(Object.keys(result.pairing).sort(), [
    "accepted", "driveFileId", "generation", "key", "lastVerifiedEnvelope",
    "pairedAt", "provider", "shareId",
  ]);
  assert.equal(Object.hasOwn(result.pairing, "payload"), false);
  assert.equal(Object.hasOwn(result.pairing, "unexpected"), false);
});

test("a stale clear cannot sanitize a corrupt cache owned by a newer boundary", () => {
  const timerSnapshot = record();
  const corruptCache = { payload: { account: "newer plaintext" } };
  const newer = record({
    accepted: acceptance(3),
    lastVerifiedEnvelope: corruptCache,
  });

  assert.throws(
    () => mergeConditionalEnvelopeClear(newer, timerSnapshot, timerSnapshot.accepted),
    assertPairingError("invalid_stored_envelope"),
  );
  assert.equal(newer.lastVerifiedEnvelope, corruptCache);
  assert.equal(newer.accepted.sequence, 3);
});

test("a stale timer cannot clear a newer cache in the same pairing generation", () => {
  const timerSnapshot = record();
  const nextAcceptance = acceptance(3);
  const nextEnvelope = cachedEnvelope(nextAcceptance);
  const newer = mergePairingUpdate(timerSnapshot, timerSnapshot, {
    accepted: nextAcceptance,
    driveFileId: "newer-file",
    lastVerifiedEnvelope: nextEnvelope,
  });

  const result = mergeConditionalEnvelopeClear(
    newer,
    timerSnapshot,
    timerSnapshot.accepted,
  );

  assert.equal(result.cleared, false);
  assert.equal(result.pairing.accepted, nextAcceptance);
  assert.equal(result.pairing.lastVerifiedEnvelope, nextEnvelope);
  assert.equal(result.pairing.driveFileId, "newer-file");
});

test("conditional cache clear compares every expected acceptance field exactly", () => {
  const current = record();
  const mismatches = [
    { ...current.accepted, sequence: current.accepted.sequence + 1 },
    { ...current.accepted, captured_at: "2026-08-03T12:00:01.000Z" },
    { ...current.accepted, expires_at: "2026-08-03T14:00:01.000Z" },
    { ...current.accepted, cipher_hash: "b".repeat(64) },
  ];

  for (const expectedAccepted of mismatches) {
    const result = mergeConditionalEnvelopeClear(current, current, expectedAccepted);
    assert.equal(result.cleared, false);
    assert.equal(result.pairing.lastVerifiedEnvelope, current.lastVerifiedEnvelope);
    assert.equal(result.pairing.accepted, current.accepted);
  }

  assert.throws(
    () => mergeConditionalEnvelopeClear(
      current,
      current,
      { ...current.accepted, share_id: OTHER_SHARE_ID },
    ),
    assertPairingError("invalid_expected_acceptance"),
  );
});

test("conditional clear is idempotent and replaced generations still fail closed", () => {
  const withoutCache = record({ lastVerifiedEnvelope: null });
  const alreadyClear = mergeConditionalEnvelopeClear(
    withoutCache,
    withoutCache,
    withoutCache.accepted,
  );
  assert.equal(alreadyClear.cleared, false);
  assert.equal(alreadyClear.pairing.lastVerifiedEnvelope, null);

  const replaced = record({ generation: OTHER_GENERATION });
  assert.throws(
    () => mergeConditionalEnvelopeClear(replaced, record(), record().accepted),
    assertPairingError("pairing_changed"),
  );
});
