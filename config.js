// This is a public OAuth client identifier, not a secret. The deployed PWA and
// the desktop uploader must use OAuth clients from the same Google Cloud project
// so both can access the same hidden Drive appDataFolder.
export const APP_CONFIG = Object.freeze({
  googleClientId: "13490783057-mboo8gqjbgcqs8aa71opcmehcjv41367.apps.googleusercontent.com",
  driveScope: "https://www.googleapis.com/auth/drive.appdata",
  pollIntervalMs: 30_000,
  limits: Object.freeze({
    maxCiphertextBytes: 262_144,
    maxTtlMs: 28_800_000,
    clockSkewMs: 120_000,
  }),
});
