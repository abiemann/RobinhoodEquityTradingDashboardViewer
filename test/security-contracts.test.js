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
