import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  applyPnlReconciliationPresentation,
  brokerRealizedTodayPresentation,
  ERA_TABLE_HEADERS,
  eraPnlPresentation,
  eraTableValues,
  pnlReconciliationPresentation,
  setHeaderStatusPillsVisible,
} from "../src/render.js";

test("enhanced broker card renders validated integer cents instead of floating-point rounding", () => {
  const enhanced = {
    snapshot: { realized_pnl_today: 2.675 },
    pnl_reconciliation: { broker_realized_pnl_cents: 268 },
  };
  const legacy = { snapshot: { realized_pnl_today: 2.675 } };

  assert.equal(brokerRealizedTodayPresentation(enhanced), "$2.68");
  assert.equal(brokerRealizedTodayPresentation(legacy), "$2.67");
});

test("broker and strategy agreement does not add a success banner", () => {
  const presentation = pnlReconciliationPresentation({
    date_et: "2026-08-04",
    broker_realized_pnl_cents: 2129,
    strategy_realized_pnl_cents: 2129,
    difference_cents: 0,
    realized_fill_count: 2,
    available_fill_count: 2,
    matched_fill_count: 2,
    status: "agrees",
  });

  assert.equal(presentation, null);
});

test("a hidden agreement clears any previously visible comparison", () => {
  const element = {
    className: "pnl-reconciliation difference",
    textContent: "old warning",
    hidden: false,
  };

  applyPnlReconciliationPresentation(element, null);

  assert.deepEqual(element, {
    className: "pnl-reconciliation",
    textContent: "",
    hidden: true,
  });
});

test("phone era table omits internal rules-version data", () => {
  assert.deepEqual(ERA_TABLE_HEADERS, [
    "Dates", "Buys", "Sells", "STOPs", "Strategy P&L (ledger fill basis)",
  ]);
  assert.deepEqual(eraTableValues({
    rules_version: "internal-version",
    first: "2026-08-03",
    last: "2026-08-04",
    buys: 1,
    sells: 2,
    stops: 0,
  }), ["2026-08-03 \u2192 2026-08-04", "1", "2", "0"]);
});

test("phone header omits the internal rules-version badge", async () => {
  const [markup, renderer] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/render.js", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(markup, /id=["']rules["']/);
  assert.doesNotMatch(renderer, /byId\(["']rules["']\)/);
});

test("header status pills hide stale prior state and reveal together", () => {
  const previousDocument = globalThis.document;
  const pills = new Map(["mode", "freshness", "sync"].map((id) => [id, { hidden: false }]));
  globalThis.document = { getElementById: (id) => pills.get(id) || null };
  try {
    setHeaderStatusPillsVisible(false);
    assert.deepEqual([...pills.values()].map((pill) => pill.hidden), [true, true, true]);
    setHeaderStatusPillsVisible(true);
    assert.deepEqual([...pills.values()].map((pill) => pill.hidden), [false, false, false]);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("matched era rows omit a redundant quality badge", async () => {
  const renderer = await readFile(new URL("../src/render.js", import.meta.url), "utf8");
  assert.doesNotMatch(renderer, /quality:\s*"matched ledger pool"/);
  assert.match(renderer, /if \(presentation\.quality\) \{\s*profitCell\.appendChild\(node\("span", "pnl-quality", presentation\.quality\)\);/s);
});

test("broker-versus-strategy differences remain explicit and authoritative", () => {
  const presentation = pnlReconciliationPresentation({
    date_et: "2026-08-04",
    broker_realized_pnl_cents: 2129,
    strategy_realized_pnl_cents: 2128,
    difference_cents: 1,
    realized_fill_count: 2,
    available_fill_count: 2,
    matched_fill_count: 2,
    status: "difference",
  });

  assert.equal(presentation.className, "pnl-reconciliation difference");
  assert.match(presentation.text, /Broker vs strategy difference/);
  assert.match(presentation.text, /difference \+\$0\.01/);
  assert.match(presentation.text, /2\/2 strategy fills matched to the ledger pool/);
  assert.match(presentation.text, /Broker is authoritative/);
});

test("equal broker and subtotal cents remain explicitly incomplete when a fill is unavailable", () => {
  const presentation = pnlReconciliationPresentation({
    date_et: "2026-08-04",
    broker_realized_pnl_cents: 2129,
    strategy_realized_pnl_cents: 2129,
    difference_cents: 0,
    realized_fill_count: 2,
    available_fill_count: 1,
    matched_fill_count: 1,
    status: "qualified",
  });

  assert.equal(presentation.className, "pnl-reconciliation qualified");
  assert.match(presentation.text, /Incomplete available strategy subtotal/);
  assert.match(presentation.text, /available strategy subtotal \$21\.29/);
  assert.match(presentation.text, /displayed difference \$0\.00/);
  assert.match(presentation.text, /1\/2 strategy fills available/);
  assert.match(presentation.text, /subtotal excludes unavailable strategy fills/);
  assert.doesNotMatch(presentation.text, /agree/i);
});

test("complete but not fully matched fills render an estimated comparison", () => {
  const presentation = pnlReconciliationPresentation({
    date_et: "2026-08-04",
    broker_realized_pnl_cents: 2129,
    strategy_realized_pnl_cents: 2128,
    difference_cents: 1,
    realized_fill_count: 2,
    available_fill_count: 2,
    matched_fill_count: 1,
    status: "qualified",
  });

  assert.equal(presentation.className, "pnl-reconciliation qualified");
  assert.match(presentation.text, /Estimated strategy comparison/);
  assert.match(presentation.text, /2\/2 strategy fills available/);
  assert.match(presentation.text, /1\/2 strategy fills matched to the ledger pool/);
  assert.doesNotMatch(presentation.text, /agree/i);
});

test("legacy snapshots and era quality never overclaim matched basis", () => {
  assert.deepEqual(pnlReconciliationPresentation(undefined), {
    className: "pnl-reconciliation legacy",
    text: "Broker vs strategy comparison is unavailable in this legacy snapshot.",
  });
  assert.deepEqual(eraPnlPresentation({ realized_pnl: 21.28 }), {
    text: "$21.28", quality: "legacy ledger", rankEligible: false,
  });
  assert.deepEqual(eraPnlPresentation({
    realized_pnl: 21.2906622026, realized_pnl_cents: 2129, pnl_quality: "matched-ledger-pool",
  }), { text: "$21.29", quality: "", rankEligible: true });
  assert.deepEqual(eraPnlPresentation({
    realized_pnl: 21.28, realized_pnl_cents: 2128, pnl_quality: "estimated",
  }), { text: "~$21.28", quality: "estimated", rankEligible: false });
  assert.deepEqual(eraPnlPresentation({
    realized_pnl: 9.78, realized_pnl_cents: 978, pnl_quality: "incomplete",
  }), { text: "$9.78 + unavailable", quality: "incomplete", rankEligible: false });
});
