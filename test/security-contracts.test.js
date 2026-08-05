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
  assert.doesNotMatch(app, /prompt:\s*["']consent["']/);
  assert.match(drive, /async connect\(\{ prompt = "" \} = \{\}\)/);
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

test("Forget stays in the title row while reconnect is centered inside the notice", async () => {
  const [html, styles, app] = await Promise.all([
    source("index.html"), source("styles.css"), source("src/app.js"),
  ]);
  assert.match(
    html,
    /<div class="header-title-row">\s*<h1>RHMRA Phone Dashboard<\/h1>\s*<button id="forget-header" class="small-action" type="button" hidden>Forget this device<\/button>\s*<\/div>/s,
  );
  assert.match(
    html,
    /<div id="notice" class="notice" hidden>\s*<p id="notice-message" class="notice-message" role="status" aria-live="polite"><\/p>\s*<button id="connect-header" class="small-action connect-action notice-connect" type="button" hidden>Connect Google Drive<\/button>\s*<\/div>/s,
  );
  assert.doesNotMatch(html, /class="header-actions"/);
  assert.match(styles, /\.header-title-row\s*\{[^}]*display:flex;[^}]*flex:0 0 100%;/s);
  assert.match(styles, /\.header-title-row #forget-header\s*\{[^}]*flex:0 0 auto;[^}]*margin-left:auto;/s);
  assert.match(styles, /\.notice-connect\s*\{[^}]*display:block;[^}]*margin:12px auto 0;/s);
  assert.doesNotMatch(styles, /@media \(max-width:540px\)[\s\S]*?h1\s*\{[^}]*flex-basis:100%;/);

  const connectPrompt = app.slice(
    app.indexOf("function askToConnect"),
    app.indexOf("async function discardCachedEnvelope"),
  );
  assert.match(connectPrompt, /showNotice\([^]*"offline", \{ connect: true \}\)/);
  assert.doesNotMatch(
    app.replace(connectPrompt, ""),
    /showNotice\([^;]*\{ connect: true \}[^;]*\);/s,
  );
  assert.match(
    app,
    /registerServiceWorker\(\)\.catch\([^]*if \(element\("notice"\)\.hidden\) \{[^]*showNotice\(/,
  );
  assert.match(app, /for \(const id of \["connect", "connect-header"\]\)/);
  assert.match(app, /resume \? "Resume Google Drive" : "Connect Google Drive"/);
  assert.match(
    app,
    /element\("connect-header"\)\?\.addEventListener\("click", \(\) => \{ void connect\(\); \}\)/,
  );
});

test("phone header stays pinned while dashboard content keeps native scrolling", async () => {
  const [html, styles, render] = await Promise.all([
    source("index.html"), source("styles.css"), source("src/render.js"),
  ]);
  assert.match(
    styles,
    /header\s*\{[^}]*position:sticky;[^}]*top:env\(safe-area-inset-top,0px\);[^}]*z-index:10;[^}]*padding-bottom:14px;[^}]*background:var\(--bg\);/s,
  );
  assert.match(
    styles,
    /header::before\s*\{[^}]*bottom:100%;[^}]*height:env\(safe-area-inset-top,0px\);[^}]*background:var\(--bg\);/s,
  );
  assert.doesNotMatch(styles, /header\s*\{[^}]*position:fixed;/s);
  assert.doesNotMatch(styles, /(?:body|main)\s*\{[^}]*overflow-y:(?:auto|scroll);/s);
  assert.match(
    html,
    /<button id="run-detail" class="run-detail" type="button" aria-hidden="true" tabindex="-1"[^>]*>\s*<span id="run-detail-text" class="run-detail-text"><\/span>\s*<\/button>\s*<span id="run-detail-status" class="visually-hidden" role="status" aria-live="polite"><\/span>/s,
  );
  assert.doesNotMatch(html, /<button id="run-detail"[^>]*>[\s\S]*?role="status"[\s\S]*?<\/button>/);
  assert.match(styles, /button\.run-detail\s*\{[^}]*grid-template-rows:0fr;[^}]*900ms/s);
  assert.match(styles, /button\.run-detail\.open\s*\{[^}]*grid-template-rows:1fr;/s);
  assert.match(render, /reconcileRunDetailSelection\(viewState\.runSelection, entries, contextKey\)/);
  assert.match(render, /syncRunDetail\(\{ scroll: true \}\)/);
  assert.doesNotMatch(render, /detail\.textContent\s*=\s*""/);
  assert.doesNotMatch(html, /by rules era/i);
  assert.doesNotMatch(render, /by rules era/i);
  assert.doesNotMatch(render, /ledger fill basis/i);
});

test("phone typography increases normal text one pixel and small text two pixels", async () => {
  const styles = await source("styles.css");
  assert.match(styles, /body\s*\{[^}]*font:15px\/1\.5/s);
  assert.match(styles, /h1\s*\{[^}]*font-size:20px;/s);
  assert.match(styles, /\.card \.value\s*\{[^}]*font-size:21px;/s);
  assert.match(styles, /\.card \.key\s*\{[^}]*font-size:13px;/s);
  assert.match(styles, /\.empty\s*\{[^}]*font-size:16px;/s);
  assert.match(styles, /\.run \.label\s*\{[^}]*font-size:13px;/s);
  assert.match(styles, /th\s*\{[^}]*font-size:13px;/s);
  assert.match(styles, /@media \(max-width:540px\)\s*\{[^}]*body\s*\{[^}]*font-size:14px;/s);
  assert.match(styles, /@media \(max-width:540px\)[\s\S]*?\.card \.value\s*\{[^}]*font-size:19px;/);
  assert.match(styles, /@media \(max-width:540px\)[\s\S]*?\.empty\s*\{[^}]*font-size:15px;/);
});

test("mobile reload defenses keep native scrolling and ship the recovery module", async () => {
  const [html, styles, worker] = await Promise.all([
    source("index.html"), source("styles.css"), source("sw.js"),
  ]);
  assert.match(html, /id="connect-header"[^>]*\bhidden\b[^>]*>Connect Google Drive<\/button>/);
  for (const id of ["mode", "freshness", "sync"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*\\bhidden\\b`));
  }
  assert.match(html, /id="welcome"[^>]*\bhidden\b/);
  assert.match(styles, /html\s*\{[^}]*overscroll-behavior-y:contain;/s);
  assert.match(styles, /body\s*\{[^}]*overscroll-behavior-y:contain;/s);
  assert.doesNotMatch(styles, /touch-action\s*:/);
  assert.match(worker, /const CACHE_PREFIX = "rhmra-phone-shell-"/);
  assert.match(worker, /rhmra-phone-shell-v15/);
  assert.match(worker, /name\.startsWith\(CACHE_PREFIX\) && name !== CACHE_NAME/);
  assert.doesNotMatch(worker, /names\.filter\(\(name\) => name !== CACHE_NAME\)/);
  assert.match(worker, /"\.\/src\/cache\.js"/);
  assert.match(worker, /"\.\/src\/expiry\.js"/);
});

test("public OAuth release pages disclose scope, purpose, Limited Use, and deletion", async () => {
  const [html, about, privacy, terms, worker, workflow] = await Promise.all([
    source("index.html"),
    source("about.html"),
    source("privacy.html"),
    source("terms.html"),
    source("sw.js"),
    source(".github/workflows/pages.yml"),
  ]);

  const disclosure = html.indexOf('class="oauth-disclosure"');
  const actions = html.indexOf('class="actions"');
  assert.ok(disclosure >= 0 && disclosure < actions);
  assert.match(html, /hidden Google Drive app-data folder/i);
  assert.match(html, /cannot browse your ordinary Drive files/i);
  assert.match(html, /not sent to the developer/i);
  assert.match(html, /\.\/privacy\.html/);
  assert.match(html, /\.\/terms\.html/);

  for (const document of [about, privacy]) {
    assert.match(document, /drive\.appdata/i);
    assert.match(document, /encrypted/i);
  }
  assert.match(privacy, /Google API Services User Data Policy/);
  assert.match(privacy, /Limited Use requirements/);
  assert.match(privacy, /Delete app data and revoke access/);
  assert.match(privacy, /myaccount\.google\.com\/connections/);
  assert.match(terms, /Terms of Use/);

  for (const page of ["about.html", "privacy.html", "terms.html"]) {
    assert.ok(worker.includes(`"./${page}"`));
    assert.match(workflow, new RegExp(`\\b${page}\\b`));
  }
});

test("public privacy and release docs disclose the laptop OAuth relay boundary", async () => {
  const [about, privacy, terms, readme, security] = await Promise.all([
    source("about.html"), source("privacy.html"), source("terms.html"),
    source("README.md"), source("SECURITY.md"),
  ]);

  for (const document of [about, privacy, readme, security]) {
    assert.match(document, /phone (?:PWA|viewer)[^]*directly[^]*Google/i);
    assert.match(document, /phone[^]*access token[^]*(?:browser |process )?memory/i);
  }
  for (const document of [about, privacy, terms, readme, security]) {
    assert.match(document, /Cloudflare Worker/i);
    assert.match(document, /authorization code/i);
    assert.match(document, /PKCE verifier/i);
    assert.match(document, /refresh token/i);
    assert.match(document, /Google(?:'s)? token response/i);
    assert.match(document, /does not (?:log or store|log or retain|put[^]*application logs)/i);
  }
  assert.match(privacy, /service provider\/data processor/i);
  assert.match(terms, /service provider/i);
  assert.match(security, /service provider\/data processor/i);
  for (const document of [privacy, security]) {
    assert.match(document, /point-of-presence-local rate limiter/i);
    assert.match(document, /ephemeral request counter/i);
    assert.match(document, /up to one minute/i);
    assert.match(document, /derived from the (?:<code>|`)?CF-Connecting-IP/i);
    assert.match(document, /solely for abuse prevention/i);
    assert.match(document, /key and counter contain no OAuth request body[^]*(?:access token)[^]*(?:refresh token)[^]*Google token response/i);
  }
  for (const document of [privacy, readme, security]) {
    assert.match(document, /DPAPI/i);
    for (const excluded of [
      /dashboard snapshots/i, /Drive files/i, /pairing (?:identifiers or )?keys/i,
      /brokerage credentials/i, /trading data/i,
    ]) assert.match(document, excluded);
  }
});

test("public docs distinguish laptop Google disconnect from phone-local forget", async () => {
  const [about, privacy, terms, readme, security] = await Promise.all([
    source("about.html"), source("privacy.html"), source("terms.html"),
    source("README.md"), source("SECURITY.md"),
  ]);

  for (const document of [about, privacy, terms, readme, security]) {
    assert.match(document, /Disconnect Google Drive/i);
    assert.match(document, /Google[^]*(?:revoke|revocation)/i);
    assert.match(document, /DPAPI/i);
    assert.match(document, /phone pairing/i);
    assert.match(document, /phone[^]*need[^]*reconnect/i);
    assert.match(document, /phone[^]*(?:disconnect|Forget this device)[^]*only[^]*(?:phone-local|phone's|that phone)/i);
    assert.match(document, /phone[^]*(?:disconnect|Forget this device)[^]*(?:do not|does not|neither)[^]*revoke/i);
  }

  for (const document of [privacy, terms, readme, security]) {
    assert.match(document, /remote revocation[^]*could not be confirmed/i);
    assert.match(document, /myaccount\.google\.com\/connections/i);
    assert.match(document, /local[^]*(?:credential)[^]*(?:still|already)[^]*cleared/i);
  }
});

test("disconnected cached dashboards hide status pills until a verified refresh", async () => {
  const [app, render] = await Promise.all([source("src/app.js"), source("src/render.js")]);

  const clear = render.slice(
    render.indexOf("export function clearDashboard"),
    render.indexOf("function renderAccount"),
  );
  assert.match(clear, /setHeaderStatusPillsVisible\(false\)/);

  const connectPrompt = app.slice(
    app.indexOf("function askToConnect"),
    app.indexOf("async function discardCachedEnvelope"),
  );
  assert.match(connectPrompt, /setHeaderStatusPillsVisible\(false\)/);

  const restore = app.slice(
    app.indexOf("async function restoreCachedView"),
    app.indexOf("async function refreshSnapshot"),
  );
  assert.ok(restore.indexOf("renderDashboard(restored.payload)") <
    restore.indexOf("setHeaderStatusPillsVisible(false)"));

  const refresh = app.slice(
    app.indexOf("async function refreshSnapshot"),
    app.indexOf("function setConnectBusy"),
  );
  const persisted = refresh.indexOf("await persistUpdates(updates)");
  const rendered = refresh.indexOf("renderDashboard(payload)");
  const checked = refresh.indexOf("markChecked()");
  const shown = refresh.indexOf("setHeaderStatusPillsVisible(true)");
  assert.ok(persisted >= 0 && persisted < rendered && rendered < checked && checked < shown);
  assert.equal((app.match(/setHeaderStatusPillsVisible\(true\)/g) || []).length, 1);
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

test("embedded browsers are gated before pairing without forwarding the private fragment", async () => {
  const [app, html] = await Promise.all([source("src/app.js"), source("index.html")]);
  assert.match(html, /id="external-browser-gate"/);
  assert.match(html, /id="open-chrome"/);
  assert.match(html, /id="copy-browser-link"/);

  const externalCheck = app.indexOf("if (requiresExternalBrowser())");
  assert.ok(externalCheck > 0);
  assert.ok(externalCheck < app.indexOf("if (requiresIosHomeScreen())"));
  assert.ok(externalCheck < app.indexOf("pairing = PAIRING_HASH ?"));
  const externalBranch = app.slice(externalCheck, app.indexOf("if (requiresIosHomeScreen())"));
  assert.match(externalBranch, /PAIRING_HASH = ""/);
  assert.match(externalBranch, /showExternalBrowserGate\(embeddedBrowserName\(\)\)/);

  assert.match(app, /const PUBLIC_PHONE_URL = new URL\("\.\.\/", import\.meta\.url\)\.href/);
  const handoff = app.slice(
    app.indexOf("function showExternalBrowserGate"),
    app.indexOf("function stopStaleTab"),
  );
  assert.match(handoff, /androidChromeIntentUrl\(PUBLIC_PHONE_URL\)/);
  assert.match(handoff, /navigator\.clipboard\.writeText\(PUBLIC_PHONE_URL\)/);
  assert.match(handoff, /element\("paste-pairing"\)\.disabled = true/);
  assert.match(handoff, /element\("connect"\)\.disabled = true/);
  assert.match(handoff, /element\("install"\)\.disabled = true/);
  assert.doesNotMatch(handoff, /PAIRING_HASH|location\.href|location\.hash/);
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
