# Security policy

RHMRA Phone Dashboard displays financial information, so privacy and fail-closed behavior are part of its functional contract.

## Reporting a vulnerability

Open a private security advisory in the GitHub repository when available. If that is unavailable, open a minimal issue asking for a private contact channel without including exploit details.

Never attach or paste:

- a View on Phone QR code or private pairing link;
- an AES key, IV/ciphertext from a live share, or accepted-sequence record;
- a Google OAuth access/refresh token or service credential;
- brokerage credentials, account/order identifiers, or raw trade data; or
- screenshots containing any of those values.

Include the affected version/commit, browser and OS, reproducible steps using synthetic data, expected behavior, and observed behavior.

## Intended guarantees

- The static PWA has no RHMRA-operated dashboard backend. Its phone PWA OAuth and Google Drive requests go directly from the browser to Google.
- Google Drive access is limited to `drive.appdata`.
- The companion laptop Agent uses a separate, stateless Cloudflare Worker only for Google OAuth token exchange. The relay transiently receives either an authorization code plus S256 PKCE verifier or a refresh token, forwards it to Google's fixed token endpoint, validates Google's token response, and returns that response to the Agent.
- The relay has no application persistence and does not log OAuth request or response contents. It never receives dashboard snapshots, Drive files, pairing identifiers or keys, brokerage credentials, or trading data.
- Dashboard plaintext is encrypted on the laptop and decrypted only in the paired viewer.
- The pairing fragment is scrubbed before the first asynchronous app operation.
- AES keys are imported as non-extractable and stored as CryptoKey objects where supported.
- The pairing record may retain only the last verified AES-GCM encrypted envelope for reload recovery; the decrypted dashboard payload is never persisted.
- Phone Google access tokens remain in browser memory only.
- On Windows, the Agent persists its Google access and refresh tokens only as current-user DPAPI ciphertext below local application data. On platforms without an equivalent supported native store, Agent tokens remain in process memory.
- The service worker caches only same-origin static shell assets and never caches encrypted envelopes, decrypted payloads, or Google API responses.
- Envelope and plaintext schemas are strict allowlists with bounded fields and collections.
- Sequence, capture-time, and same-sequence hash checks detect rollback/equivocation.
- Rendering uses DOM text nodes, not untrusted HTML.
- Polling occurs only while the document is visible.
- The viewer refuses to process pairing or local storage while embedded in a frame. GitHub Pages cannot set `frame-ancestors` as an HTTP header, so the static deployment uses an early runtime guard; deployments that control response headers should additionally send `Content-Security-Policy: frame-ancestors 'none'`.

Automated contract tests cover these properties, but they do not replace browser review and deployment testing.

## Limits of the design

The design does not protect dashboard data when the phone or laptop is compromised, when an unlocked paired device is used by another person, or when a user voluntarily shares the private link. Anyone who obtains the private pairing link can decrypt that share if they can also access its encrypted Drive file.

Google can observe the signed-in Google account, OAuth application/client and grant, source IP and device/browser details, Drive API operations, hidden app-data filename and file ID, ciphertext size, file timestamps, and request timing. Encryption does not conceal that metadata. The Google Cloud project maintainer may receive aggregate OAuth/API quota, latency, and error metrics.

Cloudflare operates the laptop OAuth relay infrastructure and acts as a service provider/data processor for those requests. It necessarily processes the transient authorization code and PKCE verifier or refresh token, Google's token response, and network metadata such as source IP, timing, headers, and Worker invocation/error information under its own terms and privacy policy. The Worker implementation has no database and does not put OAuth bodies or tokens in application logs, but this architecture cannot prevent the infrastructure provider from processing traffic needed to deliver the service. Dashboard snapshots, Drive files, pairing keys, brokerage credentials, and trading data do not pass through the relay. The static hosting provider can observe ordinary page requests and related network metadata; URL fragments containing pairing keys are not sent in those HTTP requests.

Solely for abuse prevention, Cloudflare's point-of-presence-local rate limiter keeps an ephemeral request counter for up to one minute. Its key is derived from the `CF-Connecting-IP` address supplied by Cloudflare, with a shared fallback for a missing or invalid address. The key and counter contain no OAuth request body, authorization code, PKCE verifier, access token, refresh token, or Google token response.

The session fallback stores the raw base64url key in `sessionStorage` only when the browser cannot persist a non-extractable CryptoKey. It lasts only for that tab and is explicitly disclosed in the UI.

The locally retained reload copy is the original authenticated AES-GCM encrypted envelope, not dashboard plaintext. It is accepted only when it matches the saved replay boundary and remains within its authenticated expiry. It is removed on expiry, after Google Drive confirms that sharing stopped, or when the pairing is forgotten.

In the phone viewer, disconnect discards only the in-memory access token. `Forget this device` removes only phone-local pairing state, including the cached encrypted envelope and decryption key, and discards the in-memory access token. Neither phone action deletes the remote encrypted file, requests Google revocation, or clears the laptop Agent's credential.

On the laptop, `Disconnect Google Drive` requests revocation from Google's HTTPS revocation endpoint and then clears the Agent's in-memory credential and locally saved current-user DPAPI ciphertext even if remote revocation fails or cannot be confirmed. The stable phone pairing is retained. Because the phone and laptop use the same Google application grant, confirmed revocation can require the phone to reconnect to Google. If remote revocation could not be confirmed, the user must be directed to [Google Account third-party connections](https://myaccount.google.com/connections) for immediate assurance; the local Agent credential is already cleared.

## Maintainer checklist

- Keep the OAuth web and desktop clients in the same Google Cloud project.
- Configure only the public web client ID in `config.js`; never ship a client secret.
- Keep the Desktop client secret only in the OAuth Worker's encrypted secret store; never put it in the PWA, Agent source, an installer, logs, or analytics.
- Pin the released Agent to the exact HTTPS relay endpoint, reject redirects, keep the relay stateless, and prohibit application logging of OAuth request and response bodies.
- Request only `https://www.googleapis.com/auth/drive.appdata`.
- Keep the hosted privacy-policy URL accurate in Google OAuth branding.
- Move the consent screen to the intended public/production state, complete any verification Google requires, and test with a non-maintainer account before release.
- Match the production Authorized JavaScript origin exactly and keep localhost/test clients out of the production configuration.
- Test install/pair/reconnect/expiry/Stop/Forget and Google-grant removal on both Android and iOS before release.
- Test the laptop's initial authorization and DPAPI-backed refresh path against the production relay before release, including safe failure when the relay or Google is unavailable.
- Test laptop `Disconnect Google Drive` with successful, already-revoked, failed, and unavailable Google revocation; local credentials must be cleared in every case, pairing must remain, and an unconfirmed result must direct the user to Google Account third-party connections.
- If the static host supports response headers, send `Content-Security-Policy: frame-ancestors 'none'`; retain the runtime framing guard for defense in depth.
- Serve over HTTPS with the repository CSP intact.
- Review dependency additions carefully; the production app currently has no package/runtime dependencies.
- Run `npm test` before deployment.
- Never place real pairing material in examples, logs, tests, screenshots, analytics, or bug reports.
- Treat duplicate Drive files, stale sequences, malformed payloads, and authentication ambiguity as failures rather than selecting a convenient value.

## Pairing rotation and revocation

For ordinary continuation, reuse the stable share ID/key and update the same Drive file with a monotonically increasing sequence. To rotate a compromised pairing, create a new random share ID and key, delete/revoke the old Drive file, and have the user choose **Forget this device** before pairing again.
