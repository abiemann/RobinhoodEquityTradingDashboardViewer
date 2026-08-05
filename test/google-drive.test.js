import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DriveAuthRequiredError,
  DriveNetworkError,
  DriveProtocolError,
  DriveTransientError,
  GoogleDriveClient,
  buildFileListUrl,
  parseRetryAfter,
  snapshotFileName,
} from "../src/google-drive.js";

const SHARE_ID = "ABCDEFGHIJKLMNOPQRSTUV";

test("Drive app-data filename and query are exact", () => {
  assert.equal(snapshotFileName(SHARE_ID), `rhmra-phone-v2-${SHARE_ID}.json`);
  const url = new URL(buildFileListUrl(SHARE_ID));
  assert.equal(url.origin, "https://www.googleapis.com");
  assert.equal(url.searchParams.get("spaces"), "appDataFolder");
  assert.equal(url.searchParams.get("q"), `name = 'rhmra-phone-v2-${SHARE_ID}.json' and trashed = false`);
  assert.equal(url.searchParams.get("fields"), "files(id,name,size,modifiedTime),nextPageToken");
});

test("duplicate app-data files fail closed", async () => {
  const client = new GoogleDriveClient({
    clientId: "example.apps.googleusercontent.com",
    scope: "https://www.googleapis.com/auth/drive.appdata",
    fetchImpl: async () => new Response(JSON.stringify({ files: [
      { id: "abcdefghij", name: snapshotFileName(SHARE_ID) },
      { id: "klmnopqrst", name: snapshotFileName(SHARE_ID) },
    ] }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  client.accessToken = "memory-only-token";
  client.tokenExpiresAt = Date.now() + 60_000;
  await assert.rejects(() => client.findFileId(SHARE_ID), DriveProtocolError);
});

test("a stale cached Drive file ID is re-listed so a stable pairing can resume", async () => {
  const calls = [];
  const replacementId = "replacement-file-id";
  const client = new GoogleDriveClient({
    clientId: "example.apps.googleusercontent.com",
    scope: "https://www.googleapis.com/auth/drive.appdata",
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("/files/stale-file-id?alt=media")) return new Response("", { status: 404 });
      if (url.includes("/files?")) {
        return new Response(JSON.stringify({ files: [
          { id: replacementId, name: snapshotFileName(SHARE_ID) },
        ] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes(`/files/${replacementId}?alt=media`)) {
        return new Response(JSON.stringify({ schema_version: 1 }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  client.accessToken = "memory-only-token";
  client.tokenExpiresAt = Date.now() + 60_000;
  const result = await client.fetchEnvelope(SHARE_ID, "stale-file-id");
  assert.equal(result.fileId, replacementId);
  assert.deepEqual(result.envelope, { schema_version: 1 });
  assert.equal(calls.length, 3);
});

test("disconnect discards only the in-memory token and never revokes the shared Google grant", () => {
  let revoked = false;
  const previousGoogle = globalThis.google;
  globalThis.google = { accounts: { oauth2: { revoke: () => { revoked = true; } } } };
  try {
    const client = new GoogleDriveClient({
      clientId: "example.apps.googleusercontent.com",
      scope: "https://www.googleapis.com/auth/drive.appdata",
    });
    client.accessToken = "memory-only-token";
    client.tokenExpiresAt = Date.now() + 60_000;
    client.disconnect();
    assert.equal(client.accessToken, null);
    assert.equal(client.tokenExpiresAt, 0);
    assert.equal(revoked, false);
  } finally {
    globalThis.google = previousGoogle;
  }
});

test("connect accepts a GIS token only when Drive app-data scope was granted", async () => {
  const previousGoogle = globalThis.google;
  const scope = "https://www.googleapis.com/auth/drive.appdata";
  let granted = false;
  const prompts = [];
  globalThis.google = { accounts: { oauth2: {
    hasGrantedAllScopes: (_response, requestedScope) => granted && requestedScope === scope,
    initTokenClient: (configuration) => ({
      requestAccessToken: (overrideConfiguration) => {
        prompts.push(overrideConfiguration?.prompt);
        configuration.callback({
          access_token: "new-memory-token",
          expires_in: 3_600,
        });
      },
    }),
  } } };
  try {
    const client = new GoogleDriveClient({
      clientId: "example.apps.googleusercontent.com",
      scope,
    });
    await assert.rejects(() => client.connect(), DriveAuthRequiredError);
    assert.equal(client.accessToken, null);
    assert.equal(client.tokenExpiresAt, 0);

    granted = true;
    await client.connect();
    assert.equal(client.accessToken, "new-memory-token");
    assert.equal(client.connected, true);
    assert.deepEqual(prompts, ["", ""]);
  } finally {
    globalThis.google = previousGoogle;
  }
});

test("Retry-After parsing supports delay seconds and HTTP dates", () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  assert.equal(parseRetryAfter("2", now), 2_000);
  assert.equal(parseRetryAfter(new Date(now + 5_000).toUTCString(), now), 5_000);
  assert.equal(parseRetryAfter("not-a-delay", now), null);
});

test("Drive 429 and 5xx responses are classified as transient", async () => {
  const statuses = [429, 500, 503];
  const client = new GoogleDriveClient({
    clientId: "example.apps.googleusercontent.com",
    scope: "https://www.googleapis.com/auth/drive.appdata",
    fetchImpl: async () => new Response("", {
      status: statuses.shift(),
      headers: { "Retry-After": "2" },
    }),
  });
  client.accessToken = "memory-only-token";
  client.tokenExpiresAt = Date.now() + 60_000;

  for (const expectedStatus of [429, 500, 503]) {
    await assert.rejects(
      () => client.request("https://www.googleapis.com/drive/v3/files"),
      (error) => error instanceof DriveTransientError
        && error.status === expectedStatus
        && error.retryAfterMs === 2_000
        && error.transient === true,
    );
  }
});

test("network failures identify lookup versus download and remain retryable", async () => {
  const receivers = [];
  const client = new GoogleDriveClient({
    clientId: "example.apps.googleusercontent.com",
    scope: "https://www.googleapis.com/auth/drive.appdata",
    fetchImpl: function () {
      receivers.push(this);
      throw new TypeError("Failed to fetch");
    },
  });
  client.accessToken = "memory-only-token";
  client.tokenExpiresAt = Date.now() + 60_000;

  await assert.rejects(
    () => client.request("https://www.googleapis.com/drive/v3/files"),
    (error) => error instanceof DriveNetworkError
      && error.stage === "lookup"
      && error.reason === "failed"
      && error.transient === true,
  );
  await assert.rejects(
    () => client.request("https://www.googleapis.com/drive/v3/files/file-id?alt=media"),
    (error) => error instanceof DriveNetworkError && error.stage === "download",
  );
  assert.deepEqual(receivers, [globalThis, globalThis]);
});

test("Drive requests time out as retryable network failures", async () => {
  const client = new GoogleDriveClient({
    clientId: "example.apps.googleusercontent.com",
    scope: "https://www.googleapis.com/auth/drive.appdata",
    requestTimeoutMs: 1_000,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    }),
  });
  client.accessToken = "memory-only-token";
  client.tokenExpiresAt = Date.now() + 60_000;

  await assert.rejects(
    () => client.request("https://www.googleapis.com/drive/v3/files"),
    (error) => error instanceof DriveNetworkError
      && error.reason === "timeout"
      && error.transient === true,
  );
});
