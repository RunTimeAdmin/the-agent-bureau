// CounterAudit's hash chain over a packet (src/services/packetService.js in CounterAudit): payload_hash
// is the SHA-256 of the canonical packet without its integrity block, and entry_hash the SHA-256 of
// prev_hash followed by payload_hash. CounterAudit's verify route checks this itself, but its answer
// is not signed, and COUNTERAUDIT_API_URL is a setting. The signed head names only an entry hash, so
// it says something about a packet's body only if the reader checks the body produces that hash.
//
// CounterAudit serializes with safe-stable-stringify. On anything JSON.parse can give, its bytes are
// the same as RFC 8785's canonicalize, which this repository already uses.
import { createHash } from "node:crypto";
import { canonicalizeJson, isRecord } from "./outcomeProof";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Why this packet, as the verify route gave it, does not hash to its own integrity block, or null. */
export function packetHashProblem(packet: Record<string, unknown>): string | null {
  const { integrity, ...body } = packet;
  if (!isRecord(integrity) || typeof integrity.prev_hash !== "string") {
    return "has no integrity block to check its body against";
  }
  const payloadHash = sha256(canonicalizeJson(body));
  if (payloadHash !== integrity.payload_hash) {
    return "has a body that does not produce its payload hash";
  }
  if (sha256(integrity.prev_hash + payloadHash) !== integrity.entry_hash) {
    return "has hashes that do not produce its entry hash";
  }
  return null;
}
