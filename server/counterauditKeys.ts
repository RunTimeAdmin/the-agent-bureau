// CounterAudit's export signing keys, which sign its packet proofs. Pinned here
// by pull request rather than fetched: a key fetched from the server that also
// serves the proofs would vouch only for that server, so a proof could be no
// stronger than TLS to COUNTERAUDIT_API_URL. This matters most for packets
// sealed in furnishers' own organizations (docs/cross-org-intake.md).
//
// When CounterAudit adds a key to /.well-known/counteraudit-export-jwk.json, add
// it here before its proofs arrive; proofs signed with a key not listed fail
// their proof_signature check. Keep a retired key while proofs it signed may be
// checked again.
import type { Jwks } from "./outcomeProof";

export const COUNTERAUDIT_EXPORT_KEYS: Jwks = {
  keys: [
    {
      kty: "OKP",
      crv: "Ed25519",
      kid: "counteraudit-export-ed25519-1",
      x: "Uj_vXhM3G0fVkjQ4nsxidX4RxDmyBj7rCLKP1-JREuk",
    },
  ],
};
