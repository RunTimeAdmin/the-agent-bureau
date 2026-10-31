import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertFurnishers,
  registeredSigner,
  type Furnisher,
} from "./furnishers";

const key = () =>
  `ed25519:${generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x}`;
const ORG = "4f1d2c3b-5a6e-4b7c-8d9e-0f1a2b3c4d5e";

describe("the furnisher registry", () => {
  it("accepts a well-formed listing and finds an active key", () => {
    const k = key();
    const furnishers: Record<string, Furnisher> = {
      fur_acme0001: {
        counterauditOrgId: ORG,
        keys: { "acme-2026-10": { publicKey: k, status: "active" } },
      },
    };
    expect(() => assertFurnishers(furnishers)).not.toThrow();
    expect(
      registeredSigner(furnishers, "fur_acme0001", "acme-2026-10")
    ).toEqual({
      ok: true,
      counterauditOrgId: ORG,
      publicKey: k,
    });
  });

  it("refuses a listing that could be read two ways", () => {
    const shared = key();
    const listings: Array<Record<string, Furnisher>> = [
      { "fur-bad": { counterauditOrgId: ORG, keys: {} } },
      { fur_acme0001: { counterauditOrgId: "not-an-org", keys: {} } },
      {
        fur_acme0001: {
          counterauditOrgId: ORG,
          keys: { k1: { publicKey: "ed25519:short", status: "active" } },
        },
      },
      // One key, two spellings: only the canonical one is listed.
      {
        fur_acme0001: {
          counterauditOrgId: ORG,
          keys: { k1: { publicKey: ` ${shared}`, status: "active" } },
        },
      },
      {
        fur_acme0001: {
          counterauditOrgId: ORG,
          keys: { k1: { publicKey: shared, status: "active" } },
        },
        fur_beta0001: {
          counterauditOrgId: ORG,
          keys: { k1: { publicKey: shared, status: "active" } },
        },
      },
    ];
    for (const listing of listings)
      expect(() => assertFurnishers(listing)).toThrow();
  });

  it("does not take an inherited name for a furnisher or a key", () => {
    expect(registeredSigner({}, "constructor", "k1").ok).toBe(false);
    const furnishers = {
      fur_acme0001: { counterauditOrgId: ORG, keys: {} },
    } as Record<string, Furnisher>;
    expect(registeredSigner(furnishers, "fur_acme0001", "toString").ok).toBe(
      false
    );
  });
});
