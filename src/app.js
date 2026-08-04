import { APP_CONFIG } from "../config.js";
import {
  PAIRING_VERSION,
  PROVIDER,
  ProtocolError,
  checkAcceptance,
  decodeBase64Url,
  decryptEnvelope,
  importDecryptionKey,
  parsePairingHash,
  validateEnvelope,
} from "./protocol.js";
import {
  DriveAuthRequiredError,
  DriveFileMissingError,
  DriveNetworkError,
  DriveProtocolError,
  DriveTransientError,
  GoogleDriveClient,
} from "./google-drive.js";
import { ForegroundPoller } from "./poller.js";
import { requiresIosHomeScreen } from "./platform.js";
import {
  clearDashboard,
  hideNotice,
  markChecked,
  renderDashboard,
  setWelcome,
  showNotice,
} from "./render.js";
import {
  clearPairings,
  clearSessionFallback,
  loadLatestPairing,
  loadPairing,
  loadSessionFallback,
  savePairing,
  saveSessionFallback,
  PairingStateError,
  updatePairing,
  updateSessionFallback,
} from "./storage.js";

// GitHub Pages cannot emit anti-framing response headers. Refuse to run the
// sensitive viewer when embedded, before reading a pairing fragment or local
// pairing storage. Hosts that control headers should additionally send
// Content-Security-Policy: frame-ancestors 'none'.
let framed = true;
try {
  framed = globalThis.self !== globalThis.top;
} catch {
  framed = true;
}
if (framed) {
  const blocker = document.createElement("main");
  blocker.className = "frame-block";
  blocker.setAttribute("role", "alert");
  const heading = document.createElement("h1");
  heading.textContent = "RHMRA cannot run inside another page";
  const detail = document.createElement("p");
  detail.textContent = "Open the RHMRA Phone Dashboard directly in its own browser tab or installed app.";
  blocker.append(heading, detail);
  document.body.replaceChildren(blocker);
  throw new Error("Framed RHMRA execution was blocked.");
}

// Capture the fragment for one-time pairing and remove it before the first
// await. Fragments are not sent to servers, but leaving the key visible in the
// address bar or browser history would still be an avoidable disclosure.
let PAIRING_HASH = globalThis.location?.hash || "";
if (PAIRING_HASH) {
  try {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  } catch {
    location.hash = "";
  }
}

let pairing = null;
let drive = null;
let poller = null;
let deferredInstall = null;
let dashboardVisible = false;

const element = (id) => document.getElementById(id);

function setHeaderForget(visible) {
  element("forget-header").hidden = !visible;
}

function showIosInstallGate() {
  poller?.stop();
  element("ios-install-gate").hidden = false;
  element("welcome").hidden = true;
  element("dashboard").hidden = true;
  element("paste-pairing").disabled = true;
  element("connect").disabled = true;
  setHeaderForget(false);
  setSync("install required", true);
}

function stopStaleTab(error) {
  poller?.stop();
  showNotice(
    `${error.message} Reload this app before accepting any more snapshots.`,
    "error",
  );
  setSync("pairing changed", true);
}

function setSync(text, warning = false) {
  const sync = element("sync");
  sync.textContent = text;
  sync.className = `pill${warning ? " warn" : ""}`;
}

function pairingHashFromPrivateLink(value) {
  const text = String(value || "").trim();
  if (!text) throw new ProtocolError("missing_pairing", "Paste the complete private pairing link.");
  if (text.startsWith("#")) return text;
  let parsed;
  try {
    parsed = new URL(text, location.href);
  } catch {
    throw new ProtocolError("invalid_pairing", "The private pairing link is not a valid URL.");
  }
  if (!parsed.hash) throw new ProtocolError("missing_pairing", "The private pairing link has no pairing fragment.");
  return parsed.hash;
}

function pairingPersistenceUnsupported(error) {
  return error?.name === "DataCloneError" || error?.name === "NotSupportedError" ||
    /cannot safely persist a non-extractable CryptoKey/i.test(String(error?.message || ""));
}

async function consumePairingHash(hash) {
  const parsed = parsePairingHash(hash);
  let key;
  try {
    key = await importDecryptionKey(parsed.keyBytes);
  } finally {
    parsed.keyBytes.fill(0);
  }

  let existing = null;
  try {
    existing = await loadPairing(parsed.shareId);
  } catch {
    // The save below decides whether a safe persistence fallback is possible.
  }
  const record = {
    shareId: parsed.shareId,
    provider: parsed.provider,
    key,
    accepted: existing?.accepted || null,
    driveFileId: existing?.driveFileId || null,
    pairedAt: Date.now(),
  };

  // A device has one active pairing. Remove superseded CryptoKeys before
  // storing the newly selected pairing, while preserving same-share replay
  // metadata already copied into record above.
  try { await clearPairings(); } catch { clearSessionFallback(); }
  try {
    const stored = await savePairing(record);
    clearSessionFallback();
    return { ...stored, storage: "persistent" };
  } catch (error) {
    if (!pairingPersistenceUnsupported(error)) throw error;
    saveSessionFallback({
      shareId: record.shareId,
      provider: record.provider,
      keyText: parsed.keyText,
      accepted: record.accepted,
      driveFileId: record.driveFileId,
    });
    showNotice(
      "This browser cannot persist a non-extractable key, so pairing lasts only until this tab is closed.",
      "offline",
    );
    return { ...record, keyText: parsed.keyText, storage: "session" };
  }
}

async function restorePairing() {
  try {
    let stored = await loadLatestPairing();
    if (stored?.key?.extractable === false && stored.key.type === "secret") {
      if (!stored.generation) stored = await savePairing(stored);
      return { ...stored, storage: "persistent" };
    }
  } catch {
    // A session-only fallback may still be available.
  }
  const fallback = loadSessionFallback();
  if (!fallback || fallback.provider !== PROVIDER) return null;
  const rawKey = decodeBase64Url(fallback.keyText, "key");
  try {
    if (rawKey.byteLength !== 32) throw new ProtocolError("invalid_key", "The session pairing key is invalid.");
    const key = await importDecryptionKey(rawKey);
    return { ...fallback, key, storage: "session" };
  } finally {
    rawKey.fill(0);
  }
}

async function persistUpdates(updates) {
  if (!pairing) return;
  if (pairing.storage === "session") {
    updateSessionFallback(updates);
    pairing = { ...pairing, ...updates };
    return;
  }
  const updated = await updatePairing(pairing, updates);
  pairing = { ...updated, storage: "persistent" };
}

function configuredClientId() {
  return typeof APP_CONFIG.googleClientId === "string" &&
    APP_CONFIG.googleClientId.endsWith(".apps.googleusercontent.com") &&
    !APP_CONFIG.googleClientId.startsWith("REPLACE_WITH_");
}

function prepareDrive() {
  if (!configuredClientId()) return false;
  drive = new GoogleDriveClient({
    clientId: APP_CONFIG.googleClientId,
    scope: APP_CONFIG.driveScope,
    maxBodyBytes: APP_CONFIG.limits.maxCiphertextBytes + 131_072,
  });
  poller = new ForegroundPoller({ poll: refreshSnapshot, intervalMs: APP_CONFIG.pollIntervalMs });
  return true;
}

function askToConnect(message = "Pairing is ready. Connect the Google account used by the laptop uploader.") {
  poller?.stop();
  setWelcome(message, { connect: true, forget: true });
  setHeaderForget(true);
  element("connect").textContent = "Connect Google Drive";
  setSync("disconnected", true);
}

async function refreshSnapshot() {
  if (!pairing || !drive) return;
  let stage = "Google Drive request";
  try {
    const { envelope, fileId } = await drive.fetchEnvelope(pairing.shareId, pairing.driveFileId);
    stage = "snapshot verification";
    const parsed = validateEnvelope(envelope, pairing.shareId, Date.now(), APP_CONFIG.limits);
    if (Date.now() > parsed.expiresAtMs + APP_CONFIG.limits.clockSkewMs) {
      setSync("share expired", true);
      showNotice(
        "This snapshot has expired. Keep the app open: a later laptop session can refresh the same pairing.",
        "error",
      );
      return;
    }
    const accepted = await checkAcceptance(envelope, pairing.accepted);
    const payload = await decryptEnvelope(parsed, pairing.key);
    stage = "pairing storage";
    await persistUpdates({ accepted, driveFileId: fileId });

    stage = "dashboard display";
    renderDashboard(payload);
    dashboardVisible = true;
    setHeaderForget(true);
    markChecked();
  } catch (error) {
    if (error instanceof DriveAuthRequiredError) {
      askToConnect("Google Drive authorization expired. Reconnect to resume private updates.");
      return;
    }
    if (error instanceof DriveFileMissingError) {
      try {
        await persistUpdates({ driveFileId: null });
      } catch (persistError) {
        if (persistError instanceof PairingStateError) {
          stopStaleTab(persistError);
          return;
        }
        pairing = { ...pairing, driveFileId: null };
      }
      dashboardVisible = false;
      clearDashboard();
      setHeaderForget(true);
      setWelcome(
        "Phone sharing is currently stopped. This pairing will resume automatically when the laptop starts sharing again.",
        { forget: true },
      );
      setSync("sharing paused", true);
      showNotice("No encrypted snapshot is currently shared. The pairing key remains safely stored on this device.", "offline");
      return;
    }
    if (error instanceof PairingStateError) {
      stopStaleTab(error);
      return;
    }
    if (error instanceof DriveTransientError) {
      showNotice("Google Drive is temporarily unavailable. RHMRA will retry with a bounded backoff.", "offline");
      setSync("retrying", true);
      throw error;
    }
    if (error instanceof DriveNetworkError) {
      if (!navigator.onLine) {
        showNotice("Offline. The last verified dashboard remains visible; updates resume when the app is online.", "offline");
        setSync("offline", true);
      } else {
        const action = error.stage === "download"
          ? "download the encrypted snapshot"
          : "look up the encrypted snapshot";
        const detail = error.reason === "timeout" ? "timed out" : "was blocked or interrupted";
        showNotice(
          "Google Drive could not " + action + "; the request " + detail +
            ". Check this browser's content blocker, VPN, Private DNS, or network. RHMRA will retry automatically.",
          "offline",
        );
        setSync(error.stage === "download" ? "Drive download failed" : "Drive lookup failed", true);
      }
      throw error;
    }
    if (error instanceof ProtocolError || error instanceof DriveProtocolError || error instanceof DOMException) {
      poller?.stop();
      showNotice(`A security check rejected the remote snapshot (${error.code || error.name}).`, "error");
      setSync("snapshot rejected", true);
      return;
    }
    if (!navigator.onLine) {
      showNotice("Offline. The last verified dashboard remains visible; updates resume when the app is online.", "offline");
      setSync("offline", true);
      return;
    }
    if (error instanceof TypeError) {
      showNotice("The phone viewer could not finish " + stage + ". Reload the page and try again.", "error");
      setSync("viewer error", true);
      return;
    }
    showNotice("The encrypted dashboard could not be refreshed. RHMRA will try again shortly.", "error");
    setSync("refresh failed", true);
  }
}

async function connect() {
  if (!drive || !pairing) return;
  const button = element("connect");
  button.disabled = true;
  button.textContent = "Connecting...";
  try {
    await drive.connect({ prompt: "consent" });
    hideNotice();
    setWelcome("Connected. Loading the latest encrypted snapshot...", { forget: true });
    poller.start();
  } catch (error) {
    showNotice(error?.message || "Google sign-in was not completed.", "error");
    askToConnect("Google Drive is not connected yet. Try again when you are ready.");
  } finally {
    button.disabled = false;
    button.textContent = "Connect Google Drive";
  }
}

async function forgetDevice() {
  poller?.stop();
  drive?.disconnect();
  let clearError = null;
  try {
    await clearPairings();
  } catch (error) {
    clearError = error;
  } finally {
    pairing = null;
    dashboardVisible = false;
    clearDashboard();
    setHeaderForget(false);
  }
  if (clearError) {
    setWelcome(
      "The active pairing was closed, but this browser could not erase its saved key. Close other RHMRA tabs, then tap Forget this device again. Reloading may restore the pairing until deletion succeeds.",
      { forget: true },
    );
    showNotice("Saved pairing deletion did not complete. No further snapshots will load in this tab.", "error");
    return;
  }
  hideNotice();
  setWelcome("This device has forgotten its pairing. Scan a new View on Phone QR code to connect again.");
}

async function pastePrivatePairingLink() {
  let privateLink = globalThis.prompt(
    "Paste the complete private pairing link from the laptop. It contains the decryption key and will not be saved as text.",
    "",
  );
  if (privateLink === null) return;
  try {
    const nextPairing = await consumePairingHash(pairingHashFromPrivateLink(privateLink));
    poller?.stop();
    drive?.disconnect();
    pairing = nextPairing;
    dashboardVisible = false;
    clearDashboard();
    if (!prepareDrive()) {
      setWelcome("This viewer has not been configured by its maintainer. The Google web OAuth client ID is missing.", { forget: true });
      showNotice("The public viewer configuration is incomplete.", "error");
      return;
    }
    askToConnect("Pairing saved. Connect the Google account used by the laptop uploader.");
  } catch (error) {
    showNotice(error?.message || "The private pairing link is invalid.", "error");
  } finally {
    privateLink = "";
  }
}

function wireUi() {
  element("paste-pairing").addEventListener("click", () => { void pastePrivatePairingLink(); });
  element("connect").addEventListener("click", () => { void connect(); });
  element("forget").addEventListener("click", () => { void forgetDevice(); });
  element("forget-header").addEventListener("click", () => { void forgetDevice(); });
  element("install").addEventListener("click", async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    element("install").hidden = true;
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstall = event;
    element("install").hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    element("install").hidden = true;
  });
  window.addEventListener("online", () => {
    if (pairing && drive?.connected) void poller?.runNow();
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !globalThis.isSecureContext) return;
  const script = new URL("../sw.js", import.meta.url);
  const scope = new URL("../", import.meta.url);
  await navigator.serviceWorker.register(script, { scope: scope.href });
}

async function bootstrap() {
  wireUi();
  void registerServiceWorker().catch(() => {
    showNotice("Offline installation is unavailable in this browser, but the viewer can still be used online.", "offline");
  });

  if (requiresIosHomeScreen()) {
    PAIRING_HASH = "";
    showIosInstallGate();
    return;
  }

  try {
    pairing = PAIRING_HASH ? await consumePairingHash(PAIRING_HASH) : await restorePairing();
  } catch (error) {
    showNotice(error?.message || "The pairing link could not be saved safely.", "error");
    pairing = await restorePairing().catch(() => null);
  }

  if (!pairing) {
    setWelcome("Scan a View on Phone QR code from your laptop to pair this device.");
    setHeaderForget(false);
    return;
  }
  if (pairing.provider !== PROVIDER || PAIRING_VERSION !== "2") {
    await clearPairings();
    pairing = null;
    setWelcome("This stored pairing is no longer supported. Scan a new QR code.");
    return;
  }
  setHeaderForget(true);
  if (!prepareDrive()) {
    setWelcome("This viewer has not been configured by its maintainer. The Google web OAuth client ID is missing.", { forget: true });
    showNotice("The public viewer configuration is incomplete.", "error");
    return;
  }
  askToConnect(PAIRING_HASH
    ? "Pairing saved. Connect the Google account used by the laptop uploader."
    : "Pairing restored. Connect Google Drive to resume private updates.");
}

void bootstrap().catch((error) => {
  poller?.stop();
  if (!dashboardVisible) clearDashboard();
  showNotice(error?.message || "The phone viewer could not start.", "error");
});
