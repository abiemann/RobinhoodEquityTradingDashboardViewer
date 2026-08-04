const viewState = { eraSignature: null, erasExpanded: false };

export const ERA_TABLE_HEADERS = Object.freeze([
  "Dates", "Buys", "Sells", "STOPs", "Strategy P&L (ledger fill basis)",
]);

export function eraTableValues(era) {
  return [
    era.first === era.last ? era.first : `${era.first} \u2192 ${era.last}`,
    String(era.buys),
    String(era.sells),
    String(era.stops),
  ];
}

function byId(id) {
  return document.getElementById(id);
}
function clear(element) {
  while (element?.firstChild) element.removeChild(element.firstChild);
}

function node(tag, className = "", text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function money(value) {
  if (!finite(value)) return "unavailable";
  return `${value < 0 ? "-$" : "$"}${Math.abs(value).toFixed(2)}`;
}

function moneyFromCents(value, { signed = false } = {}) {
  if (!Number.isSafeInteger(value)) return "unavailable";
  const negative = value < 0;
  const absolute = Math.abs(value);
  const prefix = negative ? "-$" : signed && value > 0 ? "+$" : "$";
  return `${prefix}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function pnlClass(value) {
  return value > 0 ? "positive" : value < 0 ? "negative" : "";
}

export function pnlReconciliationPresentation(reconciliation) {
  if (!reconciliation) {
    return {
      className: "pnl-reconciliation legacy",
      text: "Broker vs strategy comparison is unavailable in this legacy snapshot.",
    };
  }
  const broker = moneyFromCents(reconciliation.broker_realized_pnl_cents);
  const strategy = moneyFromCents(reconciliation.strategy_realized_pnl_cents);
  const fills = `${reconciliation.matched_fill_count}/${reconciliation.realized_fill_count} strategy fills matched to the ledger pool`;
  if (reconciliation.status === "qualified") {
    const difference = moneyFromCents(reconciliation.difference_cents, { signed: true });
    const available = `${reconciliation.available_fill_count}/${reconciliation.realized_fill_count} strategy fills available`;
    if (reconciliation.available_fill_count < reconciliation.realized_fill_count) {
      return {
        className: "pnl-reconciliation qualified",
        text: `Incomplete available strategy subtotal · broker ${broker} · available strategy subtotal ${strategy} · displayed difference ${difference} · ${available} · ${fills}. The subtotal excludes unavailable strategy fills. Broker is authoritative.`,
      };
    }
    return {
      className: "pnl-reconciliation qualified",
      text: `Estimated strategy comparison · broker ${broker} · estimated strategy ${strategy} · displayed difference ${difference} · ${available} · ${fills}. Broker is authoritative.`,
    };
  }
  if (reconciliation.status === "agrees") {
    return null;
  }
  const difference = moneyFromCents(reconciliation.difference_cents, { signed: true });
  return {
    className: "pnl-reconciliation difference",
    text: `Broker vs strategy difference · broker ${broker} · strategy ${strategy} · difference ${difference} · ${fills}. Broker is authoritative.`,
  };
}

export function applyPnlReconciliationPresentation(element, presentation) {
  element.className = "pnl-reconciliation";
  element.textContent = "";
  element.hidden = true;
  if (presentation) {
    element.className = presentation.className;
    element.textContent = presentation.text;
    element.hidden = false;
  }
}

export function brokerRealizedTodayPresentation(payload) {
  const reconciliation = payload?.pnl_reconciliation;
  if (Number.isSafeInteger(reconciliation?.broker_realized_pnl_cents)) {
    return moneyFromCents(reconciliation.broker_realized_pnl_cents);
  }
  return money(payload?.snapshot?.realized_pnl_today);
}

export function eraPnlPresentation(era) {
  if (!Number.isSafeInteger(era.realized_pnl_cents) || typeof era.pnl_quality !== "string") {
    return { text: money(era.realized_pnl), quality: "legacy ledger", rankEligible: false };
  }
  const amount = moneyFromCents(era.realized_pnl_cents);
  if (era.pnl_quality === "estimated") {
    return { text: `~${amount}`, quality: "estimated", rankEligible: false };
  }
  if (era.pnl_quality === "incomplete") {
    return { text: `${amount} + unavailable`, quality: "incomplete", rankEligible: false };
  }
  return { text: amount, quality: "matched ledger pool", rankEligible: true };
}

function localTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "unknown";
}

function appendCard(parent, label, value, className = "") {
  const card = node("div", "card");
  card.appendChild(node("div", `value ${className}`.trim(), value));
  card.appendChild(node("div", "key", label));
  parent.appendChild(card);
}

function cell(row, text, className = "") {
  const result = node("td", className, text);
  row.appendChild(result);
  return result;
}

export function showNotice(message, kind = "info") {
  const notice = byId("notice");
  notice.textContent = message;
  notice.className = `notice${kind === "error" ? " error" : kind === "offline" ? " offline" : ""}`;
  notice.hidden = false;
}

export function hideNotice() {
  byId("notice").hidden = true;
}

export function setWelcome(message, { connect = false, forget = false } = {}) {
  byId("welcome").hidden = false;
  byId("welcome-message").textContent = message;
  byId("connect").hidden = !connect;
  byId("forget").hidden = !forget;
}

export function hideWelcome() {
  byId("welcome").hidden = true;
}

export function clearDashboard() {
  byId("dashboard").hidden = true;
  for (const id of ["account", "positions", "runs", "run-detail", "eras", "pnl-reconciliation"]) clear(byId(id));
  byId("pnl-reconciliation").hidden = true;
  byId("mode").textContent = "PHONE";
  byId("mode").className = "pill";
  byId("freshness").textContent = "waiting";
  byId("freshness").className = "pill";
  byId("sync").textContent = "";
}

function renderAccount(payload) {
  const snapshot = payload.snapshot;
  const unrealized = snapshot.positions.reduce(
    (sum, position) => sum + (position.current_price - position.avg_buy_price) * position.quantity,
    0,
  );
  const account = byId("account");
  clear(account);
  appendCard(account, "Total value", money(snapshot.account.total_value));
  appendCard(account, "Cash", money(snapshot.account.cash));
  appendCard(account, "Buying power", money(snapshot.account.buying_power));
  appendCard(
    account,
    "Broker realized today",
    brokerRealizedTodayPresentation(payload),
    pnlClass(snapshot.realized_pnl_today),
  );
  appendCard(account, "Unrealized", money(unrealized), pnlClass(unrealized));

  const comparison = byId("pnl-reconciliation");
  const presentation = pnlReconciliationPresentation(payload.pnl_reconciliation);
  applyPnlReconciliationPresentation(comparison, presentation);
}

function renderPositions(positions) {
  const root = byId("positions");
  clear(root);
  if (positions.length === 0) {
    root.appendChild(node("span", "empty", "account is flat — no open positions"));
    return;
  }
  const wrapper = node("div", "scroll");
  const table = node("table");
  const header = node("tr");
  for (const label of ["Symbol", "Qty", "Avg buy", "Current", "Unrealized", "Stop", "To stop"]) {
    header.appendChild(node("th", "", label));
  }
  table.appendChild(header);
  for (const position of positions) {
    const row = node("tr");
    const symbolCell = cell(row, "");
    const link = node("a", "stock", position.symbol);
    link.href = `https://robinhood.com/stocks/${encodeURIComponent(position.symbol)}?source=lists_section_position`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    symbolCell.appendChild(link);
    const profit = (position.current_price - position.avg_buy_price) * position.quantity;
    const percent = position.avg_buy_price > 0 ? (position.current_price / position.avg_buy_price - 1) * 100 : 0;
    cell(row, String(position.quantity));
    cell(row, `$${position.avg_buy_price.toFixed(4)}`);
    cell(row, `$${position.current_price.toFixed(4)}`);
    cell(row, `${money(profit)} (${percent.toFixed(2)}%)`, pnlClass(profit));
    const protectedStop = position.stop_price !== null && ["confirmed", "queued"].includes(position.stop_state);
    const stopCell = cell(row, "");
    stopCell.appendChild(node(
      "span",
      `badge ${protectedStop ? "ok" : "bad"}`,
      protectedStop ? `${position.stop_state} @ $${position.stop_price.toFixed(2)}` : "UNPROTECTED",
    ));
    const distance = protectedStop && position.current_price > 0
      ? `${((position.current_price - position.stop_price) / position.current_price * 100).toFixed(2)}%`
      : "—";
    cell(row, distance);
    table.appendChild(row);
  }
  wrapper.appendChild(table);
  root.appendChild(wrapper);
}

function renderRuns(runs) {
  const root = byId("runs");
  const detail = byId("run-detail");
  clear(root);
  detail.textContent = "";
  if (runs.length === 0) {
    root.appendChild(node("span", "empty", "no runs in this snapshot"));
    return;
  }
  for (const run of runs) {
    const button = node("button", `run${run.phase === "halted" ? " halted" : ""}`);
    button.type = "button";
    button.title = run.tooltip;
    button.appendChild(node("span", "time", run.time));
    button.appendChild(node("span", "label", run.label));
    button.addEventListener("click", () => { detail.textContent = `${run.time} — ${run.tooltip}`; });
    root.appendChild(button);
  }
}

function renderEras(eras) {
  const root = byId("eras");
  const signature = JSON.stringify(eras.map((era) => [era.rules_version, era.first, era.last]));
  if (viewState.eraSignature !== null && signature !== viewState.eraSignature) viewState.erasExpanded = false;
  viewState.eraSignature = signature;
  clear(root);
  if (eras.length === 0) {
    root.appendChild(node("span", "empty", "no ledger data"));
    return;
  }

  const ranked = eras.map((era, index) => ({
    index,
    profit: Number.isSafeInteger(era.realized_pnl_cents) ? era.realized_pnl_cents : 0,
    presentation: eraPnlPresentation(era),
  }))
    .filter((era) => era.presentation.rankEligible && era.profit > 0)
    .sort((left, right) => right.profit - left.profit || left.index - right.index)
    .slice(0, 3);
  const stars = new Map(ranked.map((era, index) => [era.index, 3 - index]));
  const visible = viewState.erasExpanded ? eras : eras.slice(0, 12);
  const wrapper = node("div", "scroll");
  const table = node("table");
  const header = node("tr");
  for (const label of ERA_TABLE_HEADERS) {
    header.appendChild(node("th", "", label));
  }
  table.appendChild(header);
  visible.forEach((era, index) => {
    const row = node("tr");
    for (const value of eraTableValues(era)) cell(row, value);
    const presentation = eraPnlPresentation(era);
    const classValue = Number.isSafeInteger(era.realized_pnl_cents)
      ? era.realized_pnl_cents : era.realized_pnl;
    const profitCell = cell(row, "", pnlClass(classValue));
    const starCount = stars.get(index) || 0;
    if (starCount > 0) {
      const mark = node("span", "stars", "★".repeat(starCount));
      mark.title = `${starCount === 3 ? "Largest" : starCount === 2 ? "Second-largest" : "Third-largest"} realized profit`;
      profitCell.appendChild(mark);
    }
    profitCell.appendChild(document.createTextNode(presentation.text));
    profitCell.appendChild(node("span", "pnl-quality", presentation.quality));
    table.appendChild(row);
  });
  wrapper.appendChild(table);
  root.appendChild(wrapper);
  const remaining = eras.length - visible.length;
  if (remaining > 0) {
    const button = node("button", "action show-more", `Click to show ${remaining} more...`);
    button.type = "button";
    button.addEventListener("click", () => {
      viewState.erasExpanded = true;
      renderEras(eras);
    });
    root.appendChild(button);
  }
}

export function renderDashboard(payload) {
  hideNotice();
  hideWelcome();
  byId("dashboard").hidden = false;
  const mode = byId("mode");
  mode.textContent = payload.mode.dry_run ? "DRY" : "LIVE";
  mode.className = `pill ${payload.mode.dry_run ? "dry" : "live"}`;
  const age = Math.max(0, Math.round((Date.now() - Date.parse(payload.snapshot.run_start_pt)) / 60_000));
  const freshness = byId("freshness");
  freshness.textContent = `snapshot ${age} min old (${payload.snapshot.session})`;
  freshness.className = `pill${age > 45 ? " warn" : ""}`;
  byId("sync").textContent = `received ${localTime(payload.captured_at)}`;
  byId("eras-heading").textContent = payload.pnl_reconciliation
    ? "Strategy P&L by rules era (ledger fill basis)"
    : "Strategy P&L by rules era (legacy ledger)";
  renderAccount(payload);
  renderPositions(payload.snapshot.positions);
  renderRuns(payload.runs);
  renderEras(payload.eras);
}

export function markChecked() {
  byId("sync").textContent = `checked ${new Date().toLocaleTimeString()}`;
}
