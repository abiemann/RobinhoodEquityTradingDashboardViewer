import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { before, test } from "node:test";

import {
  ProtocolError,
  checkAcceptance,
  decryptEnvelope,
  envelopeAad,
  importDecryptionKey,
  parsePairingHash,
  validateEnvelope,
  validatePayload,
} from "../src/protocol.js";

before(() => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});

const SHARE_ID = "ABCDEFGHIJKLMNOPQRSTUV";
const LIMITS = { maxCiphertextBytes: 262_144, maxTtlMs: 28_800_000, clockSkewMs: 120_000 };

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function payload(capturedAt, expiresAt) {
  return {
    schema_version: 1,
    captured_at: capturedAt,
    expires_at: expiresAt,
    mode: { dry_run: true },
    snapshot: {
      rules_version: "abc1234",
      run_start_pt: capturedAt,
      session: "regular",
      account: { total_value: 1472.74, cash: 1176.95, buying_power: 1176.95 },
      realized_pnl_today: 0,
      positions: [{
        symbol: "OKUR", quantity: 77, avg_buy_price: 3.81, current_price: 3.83,
        stop_price: 3.67, stop_state: "confirmed",
      }],
    },
    runs: [{ time: "12:33", label: "scanned", phase: "entry", tooltip: "filtered: ABC" }],
    eras: [{ rules_version: "abc1234", first: "2026-08-03", last: "2026-08-03", buys: 1, sells: 0, stops: 0, realized_pnl: 4.28 }],
  };
}

function enhancedPayload(capturedAt, expiresAt) {
  const value = payload(capturedAt, expiresAt);
  value.snapshot.realized_pnl_today = 21.29;
  value.eras = [{
    rules_version: "abc1234", first: "2026-08-03", last: "2026-08-03",
    buys: 1, sells: 2, stops: 0, realized_pnl: 21.2906622026,
    realized_pnl_cents: 2129, pnl_quality: "matched-ledger-pool",
  }];
  value.pnl_reconciliation = {
    date_et: "2026-08-03",
    broker_realized_pnl_cents: 2129,
    strategy_realized_pnl_cents: 2129,
    difference_cents: 0,
    realized_fill_count: 2,
    available_fill_count: 2,
    matched_fill_count: 2,
    status: "agrees",
  };
  return value;
}

async function encryptedEnvelope({ sequence = 1, capturedAt = "2026-08-03T12:00:00.000Z", expiresAt = "2026-08-03T14:00:00.000Z" } = {}) {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = Uint8Array.from({ length: 12 }, (_, index) => index + 1);
  const envelope = {
    schema_version: 1,
    share_id: SHARE_ID,
    sequence,
    captured_at: capturedAt,
    expires_at: expiresAt,
    iv: base64url(iv),
    ciphertext: "pending",
  };
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: envelopeAad(envelope), tagLength: 128 },
    key,
    new TextEncoder().encode(JSON.stringify(payload(capturedAt, expiresAt))),
  );
  envelope.ciphertext = base64url(new Uint8Array(ciphertext));
  return { envelope, key, clear: payload(capturedAt, expiresAt) };
}

test("pairing fragment accepts only the exact v2 Google Drive contract", () => {
  const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  const parsed = parsePairingHash(`#v=2&provider=gdrive&id=${SHARE_ID}&key=${base64url(rawKey)}`);
  assert.equal(parsed.shareId, SHARE_ID);
  assert.equal(parsed.provider, "gdrive");
  assert.deepEqual(parsed.keyBytes, rawKey);

  assert.throws(
    () => parsePairingHash(`#v=2&provider=gdrive&id=${SHARE_ID}&key=${base64url(rawKey)}&extra=1`),
    (error) => error instanceof ProtocolError && error.code === "invalid_pairing",
  );
  assert.throws(
    () => parsePairingHash(`#v=2&v=2&provider=gdrive&id=${SHARE_ID}&key=${base64url(rawKey)}`),
    (error) => error instanceof ProtocolError && error.code === "invalid_pairing",
  );
});

test("imported pairing key is non-extractable", async () => {
  const key = await importDecryptionKey(new Uint8Array(32));
  assert.equal(key.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey("raw", key));
});

test("current dashboard envelope and AAD decrypt successfully", async () => {
  const fixture = await encryptedEnvelope();
  const parsed = validateEnvelope(fixture.envelope, SHARE_ID, Date.parse(fixture.envelope.captured_at), LIMITS);
  assert.deepEqual(await decryptEnvelope(parsed, fixture.key), fixture.clear);
});

test("schema v1 accepts both legacy and enhanced P&L payloads", () => {
  const capturedAt = "2026-08-03T12:00:00.000Z";
  const expiresAt = "2026-08-03T14:00:00.000Z";
  const envelope = { captured_at: capturedAt, expires_at: expiresAt };
  const legacy = payload(capturedAt, expiresAt);
  const enhanced = enhancedPayload(capturedAt, expiresAt);

  assert.equal(validatePayload(legacy, envelope), legacy);
  assert.equal(validatePayload(enhanced, envelope), enhanced);

  const qualifiedEstimate = enhancedPayload(capturedAt, expiresAt);
  qualifiedEstimate.pnl_reconciliation.matched_fill_count = 1;
  qualifiedEstimate.pnl_reconciliation.status = "qualified";
  assert.equal(validatePayload(qualifiedEstimate, envelope), qualifiedEstimate);
});
test("legacy payload preserves explicitly unavailable realized P&L", () => {
  const capturedAt = "2026-08-03T12:00:00.000Z";
  const expiresAt = "2026-08-03T14:00:00.000Z";
  const envelope = { captured_at: capturedAt, expires_at: expiresAt };
  const unavailable = payload(capturedAt, expiresAt);
  unavailable.snapshot.realized_pnl_today = null;

  assert.equal(validatePayload(unavailable, envelope), unavailable);

  const enhancedUnavailable = enhancedPayload(capturedAt, expiresAt);
  enhancedUnavailable.snapshot.realized_pnl_today = null;
  assert.throws(
    () => validatePayload(enhancedUnavailable, envelope),
    (error) => error instanceof ProtocolError && error.code === "invalid_pnl_reconciliation",
  );

  for (const invalid of ["unavailable", undefined, Number.NaN]) {
    const value = payload(capturedAt, expiresAt);
    value.snapshot.realized_pnl_today = invalid;
    assert.throws(
      () => validatePayload(value, envelope),
      (error) => error instanceof ProtocolError && error.code === "invalid_snapshot",
    );
  }
});


test("enhanced P&L payloads reject legacy-era mixing and invalid cents or quality", () => {
  const capturedAt = "2026-08-03T12:00:00.000Z";
  const expiresAt = "2026-08-03T14:00:00.000Z";
  const envelope = { captured_at: capturedAt, expires_at: expiresAt };
  const invalid = [];

  const mixed = enhancedPayload(capturedAt, expiresAt);
  mixed.eras = payload(capturedAt, expiresAt).eras;
  invalid.push(mixed);

  const wrongCents = enhancedPayload(capturedAt, expiresAt);
  wrongCents.eras[0].realized_pnl_cents = 2128;
  invalid.push(wrongCents);

  const fractionalCents = enhancedPayload(capturedAt, expiresAt);
  fractionalCents.eras[0].realized_pnl_cents = 2129.5;
  invalid.push(fractionalCents);

  const negativeCount = enhancedPayload(capturedAt, expiresAt);
  negativeCount.eras[0].sells = -1;
  invalid.push(negativeCount);

  const unknownQuality = enhancedPayload(capturedAt, expiresAt);
  unknownQuality.eras[0].pnl_quality = "tax-exact";
  invalid.push(unknownQuality);

  for (const value of invalid) {
    assert.throws(
      () => validatePayload(value, envelope),
      (error) => error instanceof ProtocolError && error.code === "invalid_era",
    );
  }
});

test("enhanced P&L comparison enforces date, count, arithmetic, broker, and status invariants", () => {
  const capturedAt = "2026-08-03T12:00:00.000Z";
  const expiresAt = "2026-08-03T14:00:00.000Z";
  const envelope = { captured_at: capturedAt, expires_at: expiresAt };
  const mutations = [
    (value) => { value.pnl_reconciliation.date_et = "2026-02-30"; },
    (value) => { value.pnl_reconciliation.matched_fill_count = 3; },
    (value) => { value.pnl_reconciliation.available_fill_count = 3; },
    (value) => { value.pnl_reconciliation.available_fill_count = 1; },
    (value) => { value.pnl_reconciliation.available_fill_count = -1; },
    (value) => { value.pnl_reconciliation.available_fill_count = 1.5; },
    (value) => { value.pnl_reconciliation.realized_fill_count = -1; },
    (value) => { value.pnl_reconciliation.difference_cents = 1; },
    (value) => { value.pnl_reconciliation.broker_realized_pnl_cents = 2128; },
    (value) => { value.pnl_reconciliation.status = "difference"; },
    (value) => {
      value.pnl_reconciliation.matched_fill_count = 1;
      value.pnl_reconciliation.status = "agrees";
    },
    (value) => { value.pnl_reconciliation.status = "qualified"; },
    (value) => { value.pnl_reconciliation.strategy_realized_pnl_cents = 2128.5; },
  ];

  for (const mutate of mutations) {
    const value = enhancedPayload(capturedAt, expiresAt);
    mutate(value);
    assert.throws(
      () => validatePayload(value, envelope),
      (error) => error instanceof ProtocolError && error.code === "invalid_pnl_reconciliation",
    );
  }

  const difference = enhancedPayload(capturedAt, expiresAt);
  difference.pnl_reconciliation.strategy_realized_pnl_cents = 2128;
  difference.pnl_reconciliation.difference_cents = 1;
  difference.pnl_reconciliation.status = "difference";
  assert.equal(validatePayload(difference, envelope), difference);

  const incompleteEqualSubtotal = enhancedPayload(capturedAt, expiresAt);
  incompleteEqualSubtotal.pnl_reconciliation.available_fill_count = 1;
  incompleteEqualSubtotal.pnl_reconciliation.matched_fill_count = 1;
  incompleteEqualSubtotal.pnl_reconciliation.status = "qualified";
  assert.equal(validatePayload(incompleteEqualSubtotal, envelope), incompleteEqualSubtotal);
});

test("rollback and same-sequence equivocation are rejected", async () => {
  const first = await encryptedEnvelope({ sequence: 2 });
  const accepted = await checkAcceptance(first.envelope, null);
  const rollback = { ...first.envelope, sequence: 1 };
  await assert.rejects(
    () => checkAcceptance(rollback, accepted),
    (error) => error instanceof ProtocolError && error.code === "rollback",
  );
  const conflict = { ...first.envelope, ciphertext: `${first.envelope.ciphertext.slice(0, -1)}A` };
  await assert.rejects(
    () => checkAcceptance(conflict, accepted),
    (error) => error instanceof ProtocolError && error.code === "equivocation",
  );
});

test("a higher sequence may extend expiry for stable pairing reuse", async () => {
  const first = await encryptedEnvelope({ sequence: 4 });
  const accepted = await checkAcceptance(first.envelope, null);
  const later = await encryptedEnvelope({
    sequence: 5,
    capturedAt: "2026-08-03T13:00:00.000Z",
    expiresAt: "2026-08-03T15:00:00.000Z",
  });
  const next = await checkAcceptance(later.envelope, accepted);
  assert.equal(next.sequence, 5);
  assert.equal(next.expires_at, "2026-08-03T15:00:00.000Z");
});

test("a higher sequence cannot move capture time backward", async () => {
  const first = await encryptedEnvelope({
    sequence: 8,
    capturedAt: "2026-08-03T13:00:00.000Z",
    expiresAt: "2026-08-03T15:00:00.000Z",
  });
  const accepted = await checkAcceptance(first.envelope, null);
  const older = { ...first.envelope, sequence: 9, captured_at: "2026-08-03T12:59:59.000Z" };
  await assert.rejects(
    () => checkAcceptance(older, accepted),
    (error) => error instanceof ProtocolError && error.code === "capture_rollback",
  );
});
