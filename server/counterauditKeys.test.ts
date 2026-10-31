import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COUNTERAUDIT_EXPORT_KEYS } from "./counterauditKeys";

describe("the pinned CounterAudit export keys", () => {
  it("include the key production published, as captured in the fixtures", () => {
    // fixtures/counteraudit/jwks.json is production's
    // /.well-known/counteraudit-export-jwk.json, captured with its proofs.
    const published = JSON.parse(
      readFileSync(
        path.resolve(
          import.meta.dirname,
          "fixtures",
          "counteraudit",
          "jwks.json"
        ),
        "utf8"
      )
    );
    for (const key of published.keys) {
      expect(COUNTERAUDIT_EXPORT_KEYS.keys).toContainEqual({
        kty: key.kty,
        crv: key.crv,
        kid: key.kid,
        x: key.x,
      });
    }
  });
});
