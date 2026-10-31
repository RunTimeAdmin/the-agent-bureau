// Furnishers whose events the Bureau accepts from their own CounterAudit
// organization (docs/cross-org-intake.md). The Bureau cannot take a signing key
// on CounterAudit's word here: in a furnisher's own organization, the furnisher
// registered the key itself. So each furnisher's organization and keys are
// listed below, by pull request, and an event counts only when CounterAudit's
// proof names that organization and that key.
import { parsePublicKey } from "./outcomeProof";

export type FurnisherKey = { publicKey: string; status: "active" | "revoked" };
export type Furnisher = {
  /** The one CounterAudit organization the furnisher seals its events in. */
  counterauditOrgId: string;
  /** By key_id. publicKey is `ed25519:` and 43 base64url characters, as agent-bureau-furnish prints it. */
  keys: Record<string, FurnisherKey>;
};

// The furnishers, by furnisher_id (fur_ and 6 to 32 lowercase letters or
// digits, as in the furnish schema). Adding one, adding or revoking a key, or
// moving it to another organization is a pull request. A revoked key stops new
// events; lines already stored keep their checks. None yet: until one is listed,
// sealed intake refuses every line.
export const FURNISHERS: Record<string, Furnisher> = {};

const FURNISHER_ID = /^fur_[a-z0-9]{6,32}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Exactly as the furnish tool prints it, so one key has one spelling here.
const PUBLIC_KEY = /^ed25519:[A-Za-z0-9_-]{43}$/;

/**
 * Throws on a listing that could be read two ways: a malformed id, a key that
 * does not parse or is small-order, or one public key under two furnishers or
 * two key ids (the same signer counting as two).
 */
export function assertFurnishers(furnishers: Record<string, Furnisher>) {
  const seen = new Map<string, string>();
  for (const [id, furnisher] of Object.entries(furnishers)) {
    if (!FURNISHER_ID.test(id)) throw new Error(`${id} is not a furnisher id`);
    if (!ORG_ID.test(furnisher.counterauditOrgId)) {
      throw new Error(
        `${id}: counterauditOrgId is not a CounterAudit organization id`
      );
    }
    for (const [keyId, key] of Object.entries(furnisher.keys)) {
      if (!KEY_ID.test(keyId))
        throw new Error(`${id}: ${keyId} is not a key id`);
      if (!PUBLIC_KEY.test(key.publicKey)) {
        throw new Error(
          `${id}/${keyId}: publicKey is not ed25519: and 43 base64url characters`
        );
      }
      parsePublicKey(key.publicKey);
      const other = seen.get(key.publicKey);
      if (other)
        throw new Error(`${other} and ${id}/${keyId} list the same public key`);
      seen.set(key.publicKey, `${id}/${keyId}`);
    }
  }
}
assertFurnishers(FURNISHERS);

export type RegisteredSigner =
  | { ok: true; counterauditOrgId: string; publicKey: string }
  | { ok: false; reason: string };

/** The organization and active key an event from this furnisher must come with. */
export function registeredSigner(
  furnishers: Record<string, Furnisher>,
  furnisherId: string,
  keyId: string
): RegisteredSigner {
  const furnisher = Object.hasOwn(furnishers, furnisherId)
    ? furnishers[furnisherId]
    : undefined;
  if (!furnisher) {
    return {
      ok: false,
      reason: `${furnisherId} is not a registered furnisher (server/furnishers.ts)`,
    };
  }
  const key = Object.hasOwn(furnisher.keys, keyId)
    ? furnisher.keys[keyId]
    : undefined;
  if (!key)
    return {
      ok: false,
      reason: `${furnisherId} has no registered key ${keyId}`,
    };
  if (key.status !== "active")
    return { ok: false, reason: `${furnisherId}'s key ${keyId} is revoked` };
  return {
    ok: true,
    counterauditOrgId: furnisher.counterauditOrgId,
    publicKey: key.publicKey,
  };
}
