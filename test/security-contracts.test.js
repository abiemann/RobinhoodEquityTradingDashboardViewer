import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

async function source(path) {
  return readFile(new URL(path, `file:///${root.replaceAll("\\", "/")}/`), "utf8");
}

test("rendering and controller avoid HTML injection and long-lived token storage", async () => {
  const [render, app, drive, html] = await Promise.all([
    source("src/render.js"), source("src/app.js"), source("src/google-drive.js"), source("index.html"),
  ]);
  assert.doesNotMatch(`${render}\n${app}`, /\.innerHTML\b|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(`${app}\n${drive}`, /localStorage/);
  assert.doesNotMatch(drive, /\.revoke\s*\(/);
  assert.match(drive, /hasGrantedAllScopes\(response, this\.scope\)/);
  assert.doesNotMatch(html, /<script[^>]+src="https:\/\/accounts\.google\.com/i);
  assert.match(drive, /document\.createElement\("script"\)/);
  assert.match(render, /textContent/);
  assert.match(drive, /this\.accessToken = null/);
});

test("pairing fragment is scrubbed before the first await", async () => {
  const app = await source("src/app.js");
  assert.ok(app.indexOf("history.replaceState") >= 0);
  assert.ok(app.indexOf("history.replaceState") < app.indexOf("await "));
});

test("framed execution is rejected before pairing or storage processing", async () => {
  const app = await source("src/app.js");
  assert.ok(app.indexOf("globalThis.self !== globalThis.top") >= 0);
  assert.ok(app.indexOf("globalThis.self !== globalThis.top") < app.indexOf("let PAIRING_HASH"));
  assert.ok(app.indexOf("document.body.replaceChildren(blocker)") < app.indexOf("loadLatestPairing()"));
});

test("shell URLs are project-subpath safe and service worker caches no APIs", async () => {
  const [html, manifest, worker] = await Promise.all([
    source("index.html"), source("manifest.webmanifest"), source("sw.js"),
  ]);
  assert.doesNotMatch(html, /(?:href|src)="\//);
  const parsedManifest = JSON.parse(manifest);
  assert.equal(parsedManifest.start_url, "./");
  assert.equal(parsedManifest.scope, "./");
  assert.equal(parsedManifest.icons.some((icon) => icon.type === "image/svg+xml"), false);
  assert.doesNotMatch(html, /icon\.svg/);
  assert.doesNotMatch(worker, /icon\.svg/);
  assert.match(worker, /self\.registration\.scope/);
  assert.match(worker, /cache\.put\(request, response\.clone\(\)\)/);
  assert.match(worker, /fetch\(request, \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(worker, /googleapis|accounts\.google|\/api\//i);
});

test("mobile reload defenses keep native scrolling and ship the recovery module", async () => {
  const [html, styles, worker] = await Promise.all([
    source("index.html"), source("styles.css"), source("sw.js"),
  ]);
  assert.match(html, /id="connect-header"[^>]*\bhidden\b[^>]*>Connect Google Drive<\/button>/);
  assert.match(html, /id="welcome"[^>]*\bhidden\b/);
  assert.match(styles, /html\s*\{[^}]*overscroll-behavior-y:contain;/s);
  assert.match(styles, /body\s*\{[^}]*overscroll-behavior-y:contain;/s);
  assert.doesNotMatch(styles, /touch-action\s*:/);
  assert.match(worker, /rhmra-phone-shell-v4/);
  assert.match(worker, /"\.\/src\/cache\.js"/);
  assert.match(worker, /"\.\/src\/expiry\.js"/);
});

test("verified dashboard expiry is guarded across refresh and mobile suspension", async () => {
  const app = await source("src/app.js");
  assert.match(app, /import \{ ExpiryController \} from "\.\/expiry\.js"/);
  assert.match(app, /clearLastVerifiedEnvelope/);
  assert.match(app, /expiresAtMs \+ APP_CONFIG\.limits\.clockSkewMs \+ 1/);

  const restore = app.slice(
    app.indexOf("async function restoreCachedView"),
    app.indexOf("async function refreshSnapshot"),
  );
  assert.ok(restore.indexOf("scheduleSnapshotExpiry") < restore.indexOf("renderDashboard"));
  assert.match(restore, /snapshotExpiry\.invalidate\(\)/);

  const refresh = app.slice(
    app.indexOf("async function refreshSnapshot"),
    app.indexOf("function setConnectBusy"),
  );
  const persisted = refresh.indexOf("await persistUpdates(updates)");
  const scheduled = refresh.indexOf("scheduleSnapshotExpiry(parsed.expiresAtMs)");
  const rendered = refresh.indexOf("renderDashboard(payload)", scheduled);
  assert.ok(persisted >= 0 && persisted < scheduled && scheduled < rendered);
  assert.match(refresh, /DriveFileMissingError\)[^]*snapshotExpiry\.invalidate\(\)/);

  const connectPrompt = app.slice(
    app.indexOf("function askToConnect"),
    app.indexOf("async function discardCachedEnvelope"),
  );
  assert.doesNotMatch(connectPrompt, /snapshotExpiry\.invalidate/);
  assert.match(app, /window\.addEventListener\("pageshow"[^]*snapshotExpiry\.wake\(\)/);
  assert.match(app, /document\.addEventListener\("visibilitychange"[^]*!document\.hidden[^]*snapshotExpiry\.wake\(\)/);

  const expiredUi = app.slice(
    app.indexOf("function showExpiredDashboardState"),
    app.indexOf("async function expireSnapshot"),
  );
  assert.match(expiredUi, /!drive\?\.connected \|\| !poller\?\.active/);

  const expiry = app.slice(
    app.indexOf("async function expireSnapshot"),
    app.indexOf("function pairingHashFromPrivateLink"),
  );
  assert.match(expiry, /clearLastVerifiedEnvelope\(expectedPairing, expectedAccepted\)/);
  assert.ok(expiry.indexOf("if (!isCurrent()) return") < expiry.indexOf("commit(() =>"));

  for (const lifecycle of ["showIosInstallGate", "stopStaleTab", "forgetDevice"]) {
    const start = app.indexOf(`function ${lifecycle}`);
    const next = app.indexOf("\nfunction ", start + 1);
    assert.match(app.slice(start, next < 0 ? undefined : next), /snapshotExpiry\.invalidate\(\)/);
  }

  const stale = app.slice(
    app.indexOf("function stopStaleTab"),
    app.indexOf("function setSync"),
  );
  assert.match(stale, /dashboardVisible = false/);
  assert.match(stale, /clearDashboard\(\)/);
  assert.match(stale, /setHeaderConnect\(false\)/);
  assert.match(stale, /setHeaderForget\(false\)/);
  assert.match(stale, /setWelcome\("This pairing changed in another tab\./);

  const consume = app.slice(
    app.indexOf("async function consumePairingHash"),
    app.indexOf("async function restorePairing"),
  );
  assert.doesNotMatch(consume, /snapshotExpiry\.invalidate/);
  const rePair = app.slice(
    app.indexOf("async function pastePrivatePairingLink"),
    app.indexOf("function wireUi"),
  );
  assert.ok(rePair.indexOf("const nextPairing = await consumePairingHash") <
    rePair.indexOf("snapshotExpiry.invalidate()"));
});

test("all non-timer cache deletion is acceptance-bound", async () => {
  const app = await source("src/app.js");
  assert.doesNotMatch(app, /lastVerifiedEnvelope\s*(?:=|:)\s*null/);

  const discard = app.slice(
    app.indexOf("async function discardCachedEnvelope"),
    app.indexOf("async function restoreCachedView"),
  );
  assert.match(discard, /const expectedPairing = pairing/);
  assert.match(discard, /const expectedAccepted = expectedPairing\.accepted/);
  assert.match(discard, /clearLastVerifiedEnvelope\(expectedPairing, expectedAccepted\)/);
  assert.match(discard, /pairing\?\.shareId !== result\.pairing\.shareId/);
  assert.match(discard, /pairing\?\.generation !== result\.pairing\.generation/);
  const conditionalClear = discard.indexOf("clearLastVerifiedEnvelope");
  const exactBoundary = discard.indexOf("sameAcceptanceBoundary");
  const extraUpdate = discard.indexOf("await persistUpdates(extraUpdates)", exactBoundary);
  assert.ok(conditionalClear >= 0 && conditionalClear < exactBoundary && exactBoundary < extraUpdate);

  assert.equal(app.match(/await discardCachedEnvelope\(/g)?.length, 3);
  const missing = app.slice(
    app.indexOf("if (error instanceof DriveFileMissingError)"),
    app.indexOf("if (error instanceof PairingStateError)"),
  );
  assert.match(missing, /discardCachedEnvelope\(\{ driveFileId: null \}\)/);
  assert.doesNotMatch(missing, /pairing = \{ \.\.\.pairing, driveFileId: null \}/);
});

test("privacy documentation limits reload recovery to the encrypted envelope", async () => {
  const [readme, privacy, security] = await Promise.all([
    source("README.md"), source("privacy.html"), source("SECURITY.md"),
  ]);
  for (const document of [readme, privacy, security]) {
    assert.match(document, /last verified AES-GCM encrypted envelope/i);
  }
  assert.match(readme, /decrypted payload and Google access token are never persisted/i);
  assert.match(privacy, /stores no Google access token, decrypted dashboard payload/i);
  assert.match(security, /decrypted dashboard payload is never persisted/i);
  assert.match(privacy, /access token is kept only in browser memory/i);
  assert.match(readme, /removed when it expires, Google Drive confirms that sharing stopped, or the user selects \*\*Forget this device\*\*/i);
});
test("CSP limits network access without claiming ineffective meta anti-framing", async () => {
  const [html, privacy] = await Promise.all([source("index.html"), source("privacy.html")]);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'self' https:\/\/www\.googleapis\.com https:\/\/accounts\.google\.com/);
  assert.match(html, /object-src 'none'/);
  assert.doesNotMatch(`${html}\n${privacy}`, /frame-ancestors/);
  assert.match(privacy, /\.\/icons\/icon-192\.png/);
  assert.doesNotMatch(privacy, /icon\.svg/);
});

test("iOS browser mode blocks pairing until the Home Screen app is opened", async () => {
  const [app, html] = await Promise.all([source("src/app.js"), source("index.html")]);
  assert.match(html, /id="ios-install-gate"/);
  assert.match(html, /Add to Home Screen/);
  assert.ok(app.indexOf("if (requiresIosHomeScreen())") < app.indexOf("pairing = PAIRING_HASH ?"));
  assert.match(app, /PAIRING_HASH = ""/);
  assert.match(app, /element\("paste-pairing"\)\.disabled = true/);
});

test("pairing acceptance is read, compared, and written in one transaction", async () => {
  const storage = await source("src/storage.js");
  const update = storage.slice(storage.indexOf("export async function updatePairing"));
  assert.match(update, /withStore\("readwrite"/);
  assert.ok(update.indexOf("store.get(pairing.shareId)") < update.indexOf("store.put(next)"));
  assert.doesNotMatch(update, /savePairing\(next\)/);
});

test("Forget this device clears active state even when IndexedDB deletion fails", async () => {
  const app = await source("src/app.js");
  const forget = app.slice(app.indexOf("async function forgetDevice"), app.indexOf("async function pastePrivatePairingLink"));
  assert.match(forget, /finally/);
  assert.match(forget, /pairing = null/);
  assert.match(forget, /Reloading may restore the pairing until deletion succeeds/);
  assert.match(forget, /\{ forget: true \}/);
});

test("repository ignores environment files and intentionally pins pnpm", async () => {
  const [ignore, packageText, lock] = await Promise.all([
    source(".gitignore"), source("package.json"), source("pnpm-lock.yaml"),
  ]);
  assert.match(ignore, /^\.env\*$/m);
  assert.equal(JSON.parse(packageText).packageManager, "pnpm@11.9.0");
  assert.match(lock, /lockfileVersion: '9\.0'/);
});

test("expired snapshots cannot advance acceptance state and missing files retain pairing", async () => {
  const app = await source("src/app.js");
  assert.ok(app.indexOf("Date.now() > parsed.expiresAtMs") < app.indexOf("checkAcceptance(envelope"));
  const missingBranch = app.slice(
    app.indexOf("if (error instanceof DriveFileMissingError)"),
    app.indexOf("if (error instanceof ProtocolError"),
  );
  assert.doesNotMatch(missingBranch, /clearPairings|pairing = null|poller\?\.stop/);
  assert.match(missingBranch, /driveFileId: null/);
});

test("online Drive network failures are not mislabeled as device offline", async () => {
  const app = await source("src/app.js");
  assert.match(app, /error instanceof DriveNetworkError/);
  assert.match(app, /Drive lookup failed/);
  assert.match(app, /Drive download failed/);
  assert.doesNotMatch(app, /!navigator\.onLine \|\| error instanceof TypeError/);
  assert.match(app, /phone viewer could not finish/);
});
