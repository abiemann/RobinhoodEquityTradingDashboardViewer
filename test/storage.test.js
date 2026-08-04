import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PairingStateError,
  mergeAcceptance,
  mergePairingUpdate,
} from "../src/storage.js";

const SHARE_ID = "ABCDEFGHIJKLMNOPQRSTUV";
const GENERATION = "11111111-1111-4111-8111-111111111111";
const KEY = Object.freeze({ type: "secret", extractable: false });

function acceptance(sequence, capturedAt = `2026-08-03T1${sequence}:00:00.000Z`, suffix = "a") {
  return Object.freeze({
    share_id: SHARE_ID,
    sequence,
    captured_at: capturedAt,
    expires_at: `2026-08-03T2${sequence}:00:00.000Z`,
    cipher_hash: suffix.repeat(64),
  });
}

function record(accepted = acceptance(2)) {
  return {
    shareId: SHARE_ID,
    provider: "gdrive",
    generation: GENERATION,
    key: KEY,
    accepted,
    driveFileId: "old-file",
    pairedAt: 1,
  };
}

test("an atomic pairing update preserves or advances the replay boundary", () => {
  const current = record();
  const metadataOnly = mergePairingUpdate(current, current, { driveFileId: "new-file" });
  assert.equal(metadataOnly.accepted, current.accepted);
  assert.equal(metadataOnly.driveFileId, "new-file");

  const advanced = mergePairingUpdate(current, current, { accepted: acceptance(3) });
  assert.equal(advanced.accepted.sequence, 3);
  assert.equal(advanced.generation, GENERATION);
  assert.equal(advanced.key, KEY);
});

test("a stale tab cannot regress or equivocate the replay boundary", () => {
  assert.throws(
    () => mergeAcceptance(acceptance(3), acceptance(2), SHARE_ID),
    (error) => error instanceof PairingStateError && error.code === "acceptance_regression",
  );
  assert.throws(
    () => mergeAcceptance(acceptance(2), acceptance(2, "2026-08-03T12:00:00.000Z", "b"), SHARE_ID),
    (error) => error instanceof PairingStateError && error.code === "acceptance_equivocation",
  );
  assert.throws(
    () => mergeAcceptance(acceptance(3), acceptance(4, "2026-08-03T12:59:59.000Z"), SHARE_ID),
    (error) => error instanceof PairingStateError && error.code === "capture_regression",
  );
});

test("a tab from a replaced pairing generation cannot write", () => {
  const current = record();
  const stale = { ...current, generation: "22222222-2222-4222-8222-222222222222" };
  assert.throws(
    () => mergePairingUpdate(current, stale, { driveFileId: null }),
    (error) => error instanceof PairingStateError && error.code === "pairing_changed",
  );
});
