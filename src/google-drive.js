const DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_IDENTITY_SCRIPT = "https://accounts.google.com/gsi/client";
const FILE_ID_RE = /^[A-Za-z0-9_-]{10,256}$/;
let googleIdentityPromise = null;

export class DriveAuthRequiredError extends Error {
  constructor(message = "Google Drive needs to be connected again.") {
    super(message);
    this.name = "DriveAuthRequiredError";
  }
}

export class DriveFileMissingError extends Error {
  constructor(message = "No encrypted dashboard file is currently shared.") {
    super(message);
    this.name = "DriveFileMissingError";
  }
}

export class DriveProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "DriveProtocolError";
  }
}

export class DriveNetworkError extends Error {
  constructor(stage, reason = "failed") {
    super("Google Drive request failed.");
    this.name = "DriveNetworkError";
    this.stage = stage === "download" ? "download" : "lookup";
    this.reason = reason === "timeout" ? "timeout" : "failed";
    this.transient = true;
  }
}

export class DriveTransientError extends Error {
  constructor(status, retryAfterMs = null) {
    super(`Google Drive is temporarily unavailable (${status}).`);
    this.name = "DriveTransientError";
    this.status = status;
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null;
    this.transient = true;
  }
}

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.max(0, Number(trimmed) * 1000);
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

export function snapshotFileName(shareId) {
  return `rhmra-phone-v2-${shareId}.json`;
}

export function buildFileListUrl(shareId) {
  const parameters = new URLSearchParams({
    spaces: "appDataFolder",
    q: `name = '${snapshotFileName(shareId)}' and trashed = false`,
    fields: "files(id,name,size,modifiedTime),nextPageToken",
    pageSize: "10",
  });
  return `${DRIVE_API}/files?${parameters.toString()}`;
}

function waitForGoogleIdentity(timeoutMs = 10_000) {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve(globalThis.google.accounts.oauth2);
  if (googleIdentityPromise) return googleIdentityPromise;
  if (!globalThis.document?.head) {
    return Promise.reject(new Error("Google sign-in is unavailable in this environment."));
  }

  googleIdentityPromise = new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer;
    let timeoutTimer;
    let script = document.getElementById("rhmra-google-identity");

    const cleanup = () => {
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      script?.removeEventListener("error", failed);
    };
    const ready = () => {
      if (settled || !globalThis.google?.accounts?.oauth2) return;
      settled = true;
      cleanup();
      resolve(globalThis.google.accounts.oauth2);
    };
    const failed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      script?.remove();
      reject(new Error("Google sign-in could not be loaded. Check the network and content blockers."));
    };

    if (!script) {
      script = document.createElement("script");
      script.id = "rhmra-google-identity";
      script.src = GOOGLE_IDENTITY_SCRIPT;
      script.async = true;
      script.defer = true;
      script.referrerPolicy = "no-referrer";
      document.head.append(script);
    }
    script.addEventListener("error", failed, { once: true });
    pollTimer = setInterval(ready, 50);
    timeoutTimer = setTimeout(failed, timeoutMs);
    ready();
  }).catch((error) => {
    googleIdentityPromise = null;
    throw error;
  });
  return googleIdentityPromise;
}

export class GoogleDriveClient {
  constructor({
    clientId,
    scope,
    maxBodyBytes = 393_216,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 15_000,
  }) {
    if (typeof clientId !== "string" || !clientId.endsWith(".apps.googleusercontent.com")) {
      throw new Error("The Google web OAuth client ID is not configured.");
    }
    this.clientId = clientId;
    this.scope = scope;
    this.maxBodyBytes = maxBodyBytes;
    if (typeof fetchImpl !== "function") throw new Error("Browser networking is unavailable.");
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 60_000) {
      throw new Error("The Google Drive request timeout is invalid.");
    }
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  get connected() {
    return typeof this.accessToken === "string" && Date.now() < this.tokenExpiresAt - 30_000;
  }

  async connect({ prompt = "consent" } = {}) {
    const oauth2 = await waitForGoogleIdentity();
    this.disconnect();
    return new Promise((resolve, reject) => {
      const tokenClient = oauth2.initTokenClient({
        client_id: this.clientId,
        scope: this.scope,
        callback: (response) => {
          if (!response || response.error || typeof response.access_token !== "string") {
            this.disconnect();
            reject(new DriveAuthRequiredError(response?.error_description || response?.error || "Google sign-in was not completed."));
            return;
          }
          let scopeGranted = false;
          try {
            scopeGranted = typeof oauth2.hasGrantedAllScopes === "function"
              && oauth2.hasGrantedAllScopes(response, this.scope);
          } catch {
            scopeGranted = false;
          }
          if (!scopeGranted) {
            this.disconnect();
            reject(new DriveAuthRequiredError("Google Drive app-data permission was not granted. Reconnect and approve the requested permission."));
            return;
          }
          const lifetimeSeconds = Number(response.expires_in);
          this.accessToken = response.access_token;
          this.tokenExpiresAt = Date.now() + (Number.isFinite(lifetimeSeconds) ? lifetimeSeconds : 300) * 1000;
          resolve();
        },
        error_callback: (error) => {
          this.disconnect();
          reject(new DriveAuthRequiredError(error?.message || "Google sign-in was interrupted."));
        },
      });
      tokenClient.requestAccessToken({ prompt });
    });
  }

  disconnect() {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  async request(url, stage = url.includes("alt=media") ? "download" : "lookup") {
    if (!this.connected) {
      this.accessToken = null;
      throw new DriveAuthRequiredError();
    }
    let response;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), this.requestTimeoutMs) : null;
    try {
      // A few Android WebViews brand-check native methods. Give fetch its
      // global receiver even though tests may inject an ordinary function.
      response = await this.fetchImpl.call(globalThis, url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      throw new DriveNetworkError(stage, error?.name === "AbortError" ? "timeout" : "failed");
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
    if (response.status === 401) {
      this.accessToken = null;
      this.tokenExpiresAt = 0;
      throw new DriveAuthRequiredError();
    }
    if (response.status === 404) throw new DriveFileMissingError();
    if (response.status === 403) {
      throw new DriveAuthRequiredError("Google Drive denied app-data access. Reconnect and approve the requested permission.");
    }
    if (response.status === 429 || response.status >= 500) {
      throw new DriveTransientError(
        response.status,
        parseRetryAfter(response.headers.get("Retry-After")),
      );
    }
    if (!response.ok) throw new Error(`Google Drive request failed (${response.status}).`);
    return response;
  }

  async findFileId(shareId) {
    const response = await this.request(buildFileListUrl(shareId));
    let listing;
    try {
      listing = await response.json();
    } catch (error) {
      if (error instanceof TypeError) throw new DriveNetworkError("lookup");
      throw new DriveProtocolError("Google Drive returned an invalid file list.");
    }
    if (!listing || !Array.isArray(listing.files)) throw new DriveProtocolError("Google Drive returned an invalid file list.");
    if (listing.nextPageToken || listing.files.length > 1) {
      throw new DriveProtocolError("Multiple encrypted files have the same share name; refresh was blocked.");
    }
    if (listing.files.length === 0) throw new DriveFileMissingError();
    const file = listing.files[0];
    if (!file || file.name !== snapshotFileName(shareId) || !FILE_ID_RE.test(file.id || "")) {
      throw new DriveProtocolError("Google Drive returned an unexpected encrypted file.");
    }
    return file.id;
  }

  async fetchEnvelope(shareId, knownFileId = null) {
    let fileId = knownFileId || await this.findFileId(shareId);
    if (!FILE_ID_RE.test(fileId)) throw new DriveProtocolError("The stored Google Drive file ID is invalid.");
    let response;
    try {
      response = await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
    } catch (error) {
      if (!(knownFileId && error instanceof DriveFileMissingError)) throw error;
      fileId = await this.findFileId(shareId);
      response = await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
    }
    const contentLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > this.maxBodyBytes) {
      throw new DriveProtocolError("The encrypted dashboard file is too large.");
    }
    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (error instanceof TypeError) throw new DriveNetworkError("download");
      throw new DriveProtocolError("Google Drive returned an unreadable encrypted snapshot.");
    }
    if (new TextEncoder().encode(text).byteLength > this.maxBodyBytes) {
      throw new DriveProtocolError("The encrypted dashboard file is too large.");
    }
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new DriveProtocolError("The encrypted dashboard file is not valid JSON.");
    }
    return Object.freeze({ envelope, fileId });
  }
}
