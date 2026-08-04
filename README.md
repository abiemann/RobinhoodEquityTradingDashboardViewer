# RHMRA Phone Dashboard

RHMRA Phone Dashboard is an installable, read-only Progressive Web App for viewing an encrypted RHMRA dashboard on Android or iOS. It is a static site: there is no RHMRA account server, shared financial-data backend, or laptop web server.

The public repository is [`RobinhoodEquityTradingDashboardViewer`](https://github.com/abiemann/RobinhoodEquityTradingDashboardViewer).

The laptop uploader writes one encrypted JSON envelope to the user's Google Drive `appDataFolder`. The PWA polls that hidden app-data file directly from the browser and decrypts it locally. Google provides the user's private online data box; the user does not need to create or administer a bucket.

## What the end user needs

An end user needs only:

- a free Google account;
- the public RHMRA Phone web address;
- the RHMRA laptop dashboard; and
- the private pairing link or QR code created by **View on Phone**.

End users do **not** need GitHub, Cloudflare, a Google Cloud project, a web server, or an Android/iOS developer account. The PWA maintainer configures Google OAuth once for everyone. Users simply sign in to Google and approve access to this app's hidden Drive data folder.

## Install and pair (Android and iOS)

Install the PWA before pairing so the key is saved in the installed app's own storage:

1. Open the public RHMRA Phone URL on the phone.
2. Install it:
   - **Android / Chrome:** browser menu -> **Install app** or **Add to Home screen**.
   - **iPhone / Safari:** Share -> **Add to Home Screen**.
3. Open **RHMRA** from the phone's Home Screen.
4. On the laptop dashboard, select **View on Phone**, create the secure share, and choose **Copy private link**.
5. Transfer that private link to the phone using a trusted method, copy it, and tap **Paste private pairing link** inside the installed PWA.
6. Tap **Connect Google Drive** and sign in with the same Google account used by the laptop uploader.

The normal camera/QR flow is still a convenient browser fallback. On iOS, however, Safari and a Home Screen web app have separate storage, so scanning before installation can pair Safari instead of the installed PWA. Pasting inside the installed app avoids that problem. Never post or forward the QR code or private link: it contains the dashboard decryption key.

To prevent an easy-to-miss pairing in the wrong storage container, the viewer disables pairing when it detects an iPhone or iPad running outside Home Screen/standalone mode. Follow the displayed **Add to Home Screen** instructions, open the installed RHMRA app, and pair there.

The pairing survives future laptop sessions. The laptop must reuse the same `share_id` and key, update the same Drive file, and advance `sequence`. Google access tokens deliberately stay in memory, so the phone may occasionally ask the user to reconnect after a reload or token expiry. A reload can immediately restore the last verified dashboard from the original AES-GCM encrypted envelope saved in the pairing record; the decrypted payload and Google access token are never persisted.

## How it works

1. The laptop captures a strict, read-only dashboard field allowlist.
2. It encrypts the payload with AES-256-GCM and uploads the envelope to Google Drive's hidden `appDataFolder`.
3. The private pairing link supplies the share identifier and AES key in a URL fragment:

   ```text
   #v=2&provider=gdrive&id=<share_id>&key=<base64url-key>
   ```

4. The PWA removes the fragment from the address bar before its first asynchronous operation, imports the key as a non-extractable Web Crypto key, and persists it in IndexedDB where supported.
5. While visible, the PWA polls Google Drive every 30 seconds, validates the envelope and payload, rejects rollback/equivocation, decrypts locally, and renders with safe DOM text APIs. After successful verification, it retains the original AES-GCM encrypted envelope in the pairing record so a reload can restore the last verified view without storing dashboard plaintext.
6. When backgrounded, polling stops. Returning to the app triggers an immediate refresh.

Successful foreground refreshes remain on a 30-second schedule. Google Drive `429` and `5xx` responses use bounded exponential retry with jitter, honor `Retry-After`, and cap the delay at five minutes. A successful request or return to the foreground resets that backoff.

The service worker caches only the static application shell. It never caches Google API responses, OAuth tokens, encrypted envelopes, or decrypted dashboard data. The last verified AES-GCM encrypted envelope is stored only in the local pairing record and is removed when it expires, Google Drive confirms that sharing stopped, or the user selects **Forget this device**.

## Maintainer setup (one time, not for end users)

The person publishing the PWA performs these steps once.

### 1. Create the Google application

In one Google Cloud project:

1. Enable the **Google Drive API**.
2. Configure the OAuth consent/branding screen and provide this repository's hosted [`privacy.html`](./privacy.html) URL.
3. Request only this scope:

   ```text
   https://www.googleapis.com/auth/drive.appdata
   ```

4. Create an OAuth client of type **Web application** for the PWA.
5. Add the static site's origin under **Authorized JavaScript origins**. For GitHub Pages that is normally:

   ```text
   https://abiemann.github.io
   ```

   Origins do not include the `/RobinhoodEquityTradingDashboardViewer/` path. Add localhost origins separately for local development when needed.
6. Create the laptop uploader's **Desktop app** OAuth client in the same Google Cloud project. Using the same project makes the web and desktop clients parts of the same Google application and gives them access to the same app-data space for a signed-in user.
7. Complete Google's publishing, test-user, and verification requirements that apply to the chosen OAuth configuration.

### 2. Configure the public client ID

Edit [`config.js`](./config.js) and replace only:

```js
googleClientId: "REPLACE_WITH_GOOGLE_WEB_CLIENT_ID.apps.googleusercontent.com"
```

The web OAuth client ID is public configuration, not a password. Do not add an OAuth client secret, refresh token, access token, pairing key, or laptop credential to this repository.

### 3. Publish the static site

The repository includes a pinned GitHub Actions workflow that verifies the PWA and publishes only its static application allowlist. In **Settings -> Pages**, set **Source** to **GitHub Actions**. The workflow deploys automatically from `main`; a maintainer can also start it manually from **Actions -> Publish PWA to GitHub Pages** for a controlled prerelease. It refuses to publish while `config.js` still contains the placeholder Google client ID.

All URLs, the manifest, and the service-worker scope are relative, so the project URL `https://abiemann.github.io/RobinhoodEquityTradingDashboardViewer/` is supported. After deployment, confirm:

- the dashboard loads at the project URL;
- `privacy.html` is public;
- the browser reports the site as installable; and
- the OAuth web client's authorized origin matches the deployed origin exactly.

Only the maintainer performs these steps. A user of the published PWA sees only Google sign-in/consent.

### 4. Public-release checklist

Before giving the URL to end users:

- set the OAuth consent screen to the intended public/production state rather than leaving it limited to test users;
- verify the app name, support contact, developer contact, homepage, hosted privacy URL, and any authorized domains shown by Google;
- confirm the only requested Drive scope is `https://www.googleapis.com/auth/drive.appdata` and complete Google verification if Google requires it;
- confirm the Web and Desktop OAuth clients are in the same project, put only the Web client ID in this repository, and configure the separate Desktop client ID in the laptop uploader;
- make the Web client's Authorized JavaScript origin exactly match the production origin (scheme and host, with no repository path or trailing path);
- remove production dependence on localhost/test clients and make sure no OAuth client secret, access token, refresh token, pairing key, or `.env` file is committed;
- test a brand-new pairing end to end with a non-maintainer Google account on both Android and iOS, including install, sign-in, foreground polling, expiry, Stop, and **Forget this device**;
- test Google-grant removal and reconnection so the recovery instructions are accurate; and
- publish the privacy and security documents before requesting OAuth approval or verification.

## Laptop uploader contract

The uploader must authenticate to Drive with the desktop OAuth client from the same Cloud project and request only `drive.appdata`. It must create or update exactly one file in `appDataFolder` named:

```text
rhmra-phone-v2-<share_id>.json
```

The PWA queries that exact name with `trashed = false` and fails closed if duplicates exist. Once discovered, the Drive file ID is retained locally and reused.

Use a stable 32-byte AES key and stable 22-64 character base64url `share_id` across laptop sessions. Never reset or reuse a sequence number for different content. Each accepted update must have a higher safe-integer `sequence` and a nondecreasing `captured_at`. A higher sequence may extend `expires_at`; changing content or expiry at the same sequence is rejected as equivocation.

The envelope has exactly these fields:

```json
{
  "schema_version": 1,
  "share_id": "...",
  "sequence": 1,
  "captured_at": "2026-08-03T12:00:00.000Z",
  "expires_at": "2026-08-03T14:00:00.000Z",
  "iv": "<12-byte-base64url>",
  "ciphertext": "<AES-GCM-ciphertext-base64url>"
}
```

AES-GCM additional authenticated data is the UTF-8 encoding of:

```js
JSON.stringify([schema_version, share_id, sequence, captured_at, expires_at])
```

The decrypted payload schema is validated strictly by [`src/protocol.js`](./src/protocol.js). Schema version 1 accepts the original legacy shape and one coordinated enhanced shape. Enhanced payloads add `pnl_reconciliation` plus `realized_pnl_cents` and `pnl_quality` on every rules-era row. Integer cents are the display authority. Reconciliation counts enforce `0 <= matched_fill_count <= available_fill_count <= realized_fill_count`; incomplete or estimated comparisons must use `qualified`, while fully matched comparisons use `agrees` only for a zero-cent difference and `difference` otherwise. The comparison is between broker telemetry and the strategy's ledger-fill basis—it does not claim tax-lot reconciliation, and equal broker/subtotal cents never imply agreement when any strategy fill is unavailable or unmatched. The payload contains only `mode`, the account summary/positions, runs, P&L comparison, and rules-era aggregates needed by the dashboard. Do not add raw ledgers, account/order identifiers, credentials, filesystem paths, constants, or arbitrary HTML.

The complete link emitted by the laptop must append the exact fragment to the deployed PWA base URL. The AES key belongs only in the fragment; never put it in a query string, file, API request, or log.

## Security and privacy

- Pairing keys stay on the paired device and are non-extractable where the browser supports CryptoKey cloning.
- A session-only fallback is used only when that non-extractable key cannot be cloned into IndexedDB.
- The pairing record may retain the last verified AES-GCM encrypted envelope until its authenticated expiry, a confirmed Stop, or **Forget this device**. It never retains the decrypted dashboard payload.
- OAuth access tokens remain in memory and are never placed in IndexedDB, local storage, the service-worker cache, or URLs.
- Disconnect and **Forget this device** only discard the phone's in-memory access token. They deliberately do not revoke the shared Google application grant, because revocation could also invalidate the laptop uploader's authorization. Revoking the application is a separate action in the user's Google Account.
- The app rejects unknown fields, malformed sizes/timestamps, stale capture times, lower sequences, and same-sequence conflicts.
- A 401 requires reconnection. When laptop sharing stops and its Drive file disappears, the phone removes its cached encrypted envelope but keeps the stable pairing and polls for a replacement file with the exact same share name; a later laptop session resumes automatically. An expired share also discards its cached envelope while remaining paired so a later, higher sequence can safely revive it.
- UI rendering uses `textContent`/DOM nodes rather than HTML strings.
- The app has no analytics, advertisements, or developer-operated collection endpoint.
- Google still receives the signed-in account identity and OAuth/Drive request metadata, including the Google application/client, request IP and device/browser information, hidden app-data filename/ID, ciphertext size, file timestamps, and request timing. Encryption protects the dashboard contents, not that metadata. The static host sees ordinary page requests, but URL fragments containing pairing keys are not sent in HTTP requests.

See [Privacy](./privacy.html) and [Security](./SECURITY.md) for details and limitations.

## Local development

No runtime dependencies or build step are required. Use Node.js 20 or newer for tests. The dependency-free `pnpm-lock.yaml` is intentionally kept so the package-manager format remains reproducible:

```powershell
npm run verify
```

Every push and pull request to `main` runs the same syntax and test checks in GitHub Actions without installing third-party packages.

Serve the repository root on localhost rather than opening `index.html` directly so ES modules and the service worker work correctly. For example:

```powershell
python -m http.server 8080
```

Then add `http://localhost:8080` to the web OAuth client's authorized JavaScript origins and open that address. Do not commit a real private pairing link or key in fixtures, screenshots, issues, or test output.

## License

MIT. See [`LICENSE`](./LICENSE).
