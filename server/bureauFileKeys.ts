// The Bureau's keys for signing agents' files (docs/agent-file.md), by key id.
// Pinned here by pull request and served at
// /.well-known/agent-bureau-file-keys.json, so a subscriber can check a file
// against a key that does not come from the file. A file is signed only with a
// key listed here, by `pnpm file assemble`, where its private key is kept.
//
// To add a key: `pnpm file keygen <private-key-file>` where the key will live,
// list the public key it prints under a new key id, merge, then sign with it.
// Keep a retired key while files it signed may be checked.
export const BUREAU_FILE_KEYS: Record<string, string> = {
  // Made 2026-11-01; its private key is root-only on the operator's VPS.
  "bureau-file-2026-11": "ed25519:7yToZTSFxe0M6ImlmeKs6ExsIfiU99liBguCALjh6RI",
};
