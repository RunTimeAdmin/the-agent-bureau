import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// CounterAudit's signed heads in these fakes use a key made for the test run (server/testCheckpoint.ts).
vi.mock("./counterauditKeys", async importOriginal => {
  const actual = await importOriginal<typeof import("./counterauditKeys")>();
  const { TEST_EXPORT_KEY } = await import("./testCheckpoint");
  return { COUNTERAUDIT_EXPORT_KEYS: { keys: [...actual.COUNTERAUDIT_EXPORT_KEYS.keys, TEST_EXPORT_KEY] } };
});
const ORG = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
vi.mock("./reviewLog", async importOriginal => ({
  ...(await importOriginal<typeof import("./reviewLog")>()),
  REVIEW_ORG_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
}));

import type { ReviewLogRecordRow } from "../drizzle/schema";
import { DISPUTE_CONNECTOR_ID } from "./dispute";
import { EVIDENCE_CONNECTOR_ID, evidenceRecordFor, readBureauOrganization, sealFor } from "./evidenceSeal";
import { canonicalizeJson } from "./outcomeProof";
import { packetHashProblem } from "./packetHash";
import { REVIEW_CONNECTOR_ID } from "./reviewLog";
import { readReviewLog, readReviewPacket } from "./reviewLogSync";
import { checkpointResponse, tombstoneOf } from "./testCheckpoint";

const API = "https://api.counteraudit.test";
const NOW = new Date("2026-11-06T02:00:00.000Z");
const ZERO = "0".repeat(64);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Packet = Record<string, unknown> & {
  packet_id: string;
  integrity: { chain_mode: string; prev_hash: string; payload_hash: string; entry_hash: string };
};

/** A chain as CounterAudit seals one: each body hashed, each entry hash over the one before. */
function sealChain(
  records: unknown[],
  options: { connector?: string; prev?: string; from?: number; idFrom?: number } = {}
): Packet[] {
  const { connector = REVIEW_CONNECTOR_ID, prev = ZERO, from = 0, idFrom = 0 } = options;
  let last = prev;
  return records.map((record, n) => {
    const body = {
      packet_id: idOf(idFrom + from + n),
      org_id: ORG,
      connector_id: connector,
      created_at: new Date(NOW.getTime() - 60_000 + n).toISOString(),
      sequence: from + n,
      signed_event: record,
    };
    const payload = sha256(canonicalizeJson(body));
    const entry = sha256(last + payload);
    const packet = {
      ...body,
      integrity: { chain_mode: from + n === 0 ? "genesis" : "chained", prev_hash: last, payload_hash: payload, entry_hash: entry },
    };
    last = entry;
    return packet;
  });
}

const headOf = (packet: Packet, sequence: number) => ({
  sequence,
  entryHash: packet.integrity.entry_hash,
  packetId: packet.packet_id,
});

/**
 * What answers at COUNTERAUDIT_API_URL. It forwards a head signed over the real chain, and may list
 * and serve something else: the signed head is the one thing it cannot make up.
 */
function endpoint(signed: Packet[], served: Packet[] = signed, erased: Record<string, unknown> = {}) {
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname === `/v1/audit/chain/${ORG}/checkpoint`) {
      const tip = signed.at(-1);
      return checkpointResponse(ORG, tip ? headOf(tip, signed.length - 1) : null, u.searchParams.get("nonce"));
    }
    if (u.pathname === "/v1/audit/packets") {
      return Response.json({
        packets: [...served].reverse().map(p => ({
          packet_id: p.packet_id,
          connector_id: p.connector_id,
          created_at: p.created_at,
          expired_at: p.packet_id in erased ? "2028-11-02T12:00:00.000Z" : null,
          prev_hash: p.integrity.prev_hash,
          entry_hash: p.integrity.entry_hash,
        })),
        next_cursor: null,
      });
    }
    const packet = served.find(p => u.pathname.endsWith(p.packet_id));
    if (packet && packet.packet_id in erased) {
      return Response.json({ error: "expired", signed_tombstone: erased[packet.packet_id] }, { status: 410 });
    }
    return packet
      ? Response.json({ valid: true, entry_hash: packet.integrity.entry_hash, packet })
      : Response.json({ error: "not_found" }, { status: 404 });
  });
}

const read = (fetch: ReturnType<typeof endpoint>, known: ReviewLogRecordRow[] = []) =>
  readReviewLog({ apiUrl: API, readKey: "ca_read", orgId: ORG, known, fetch, now: NOW });
const stored = (packets: Packet[]) =>
  packets.map((p, n) => ({
    id: n + 1,
    sequence: p.sequence as number,
    packetId: p.packet_id,
    prevHash: p.integrity.prev_hash,
    entryHash: p.integrity.entry_hash,
    connectorId: p.connector_id as string,
    sealedAt: NOW,
    record: p.signed_event as Record<string, unknown>,
    readAt: NOW,
  }));

const APPROVAL = { schema: "x", decision: "approve" };
const REJECTION = { schema: "x", decision: "reject", reason: "related payer" };

describe("packetHashProblem", () => {
  // Computed by CounterAudit's own safe-stable-stringify and hash (src/services/packetService.js).
  const VECTOR = {
    body: {
      packet_id: "11111111-2222-4333-8444-555555555555",
      org_id: ORG,
      connector_id: "agent-bureau-review-v1",
      created_at: "2026-11-06T02:00:00.000Z",
      sequence: 7,
      retention_years: 7,
      signed_event: { z: 'é\n"𝒳', a: [1, 1.5, 1e21, null, true], m: { b: " ", a: "<&>" } },
    },
    prev: "ab".repeat(32),
    payload: "ff67ba96d2f0fcf42af193086621717c340cb9be5dfabfcf36e9f0d5ee74d733",
    entry: "a48f827748ec6114be79e74cc2649151a7ea7c5cb5ac91170ef73d2a71884fab",
  };
  const sealed = () => ({
    ...VECTOR.body,
    integrity: { chain_mode: "chained", prev_hash: VECTOR.prev, payload_hash: VECTOR.payload, entry_hash: VECTOR.entry },
  });

  it("takes what CounterAudit's own code seals", () => {
    expect(packetHashProblem(sealed())).toBeNull();
    // chain_mode is outside the hash, and says nothing the Bureau reads.
    expect(packetHashProblem({ ...sealed(), integrity: { ...sealed().integrity, chain_mode: "x" } })).toBeNull();
  });

  it.each([
    ["signed_event removed", ({ signed_event: _gone, ...rest }: Record<string, unknown>) => rest],
    ["created_at rewritten", (p: Record<string, unknown>) => ({ ...p, created_at: "2026-01-01T00:00:00.000Z" })],
    ["connector_id rewritten", (p: Record<string, unknown>) => ({ ...p, connector_id: "another" })],
    ["sequence rewritten", (p: Record<string, unknown>) => ({ ...p, sequence: 8 })],
    ["org_id rewritten", (p: Record<string, unknown>) => ({ ...p, org_id: "another" })],
    ["a field added", (p: Record<string, unknown>) => ({ ...p, extra: 1 })],
    ["the record rewritten", (p: Record<string, unknown>) => ({ ...p, signed_event: { ...VECTOR.body.signed_event, a: [] } })],
  ])("refuses a body with %s", (_what, change) => {
    expect(packetHashProblem(change(sealed()))).toBe("has a body that does not produce its payload hash");
  });

  it("refuses hashes that do not follow from one another", () => {
    const changed = (fields: Record<string, string>) => ({ ...sealed(), integrity: { ...sealed().integrity, ...fields } });
    expect(packetHashProblem(changed({ prev_hash: "cd".repeat(32) }))).toBe("has hashes that do not produce its entry hash");
    expect(packetHashProblem(changed({ entry_hash: "cd".repeat(32) }))).toBe("has hashes that do not produce its entry hash");
    expect(packetHashProblem(changed({ payload_hash: "cd".repeat(32) }))).toBe("has a body that does not produce its payload hash");
    const { integrity: _gone, ...bare } = sealed();
    expect(packetHashProblem(bare)).toBe("has no integrity block to check its body against");
  });
});

describe("reading the review log against the signed head", () => {
  const chain = () => sealChain([{ schema: "genesis" }, APPROVAL, REJECTION]);

  it("takes a chain whose bodies hash up to the signed head", async () => {
    const result = await read(endpoint(chain()));
    expect(result.problem).toBeNull();
    expect(result.rows.map(r => r.sequence)).toEqual([0, 1, 2]);
    expect(result.rows[2].record).toEqual(REJECTION);
  });

  it("refuses a rejection whose body was emptied, and stores nothing", async () => {
    const real = chain();
    const { signed_event: _gone, ...emptied } = real[2];
    const result = await read(endpoint(real, [real[0], real[1], emptied as Packet]));
    expect(result.problem).toBe(`packet ${idOf(2)} has a body that does not produce its payload hash`);
    expect(result.rows).toEqual([]);
  });

  it("refuses a rewritten seal time, which the one-day limit on key records reads", async () => {
    const real = chain();
    const result = await read(endpoint(real, [{ ...real[0], created_at: "2026-11-05T01:59:00.000Z" }, real[1], real[2]]));
    expect(result.problem).toBe(`packet ${idOf(0)} has a body that does not produce its payload hash`);
    expect(result.rows).toEqual([]);
  });

  it("refuses a rewritten connector, which decides whether a packet's record is read", async () => {
    const real = chain();
    const result = await read(endpoint(real, [real[0], real[1], { ...real[2], connector_id: "another" }]));
    expect(result.problem).toBe(`packet ${idOf(2)} has a body that does not produce its payload hash`);
    expect(result.rows).toEqual([]);
  });

  it("stops at the signed head a log hashed again without the rejection, and stores nothing", async () => {
    const real = chain();
    // Every hash follows from its body, and every packet links to the one before.
    const forged = sealChain([{ schema: "genesis" }, APPROVAL, APPROVAL]);
    const result = await read(endpoint(real, forged));
    expect(result.problem).toBe("CounterAudit's signed checkpoint names another packet at sequence 2 than the log read holds");
    expect(result.rows).toEqual([]);
  });

  it("stores nothing from a read that stopped short of the signed head", async () => {
    const real = chain();
    // A gap, with a forged packet before it that hashes and links.
    const forged = sealChain([{ schema: "genesis" }, APPROVAL]);
    const gapped = await read(endpoint(real, [forged[0], real[2]]));
    expect(gapped.problem).toMatch(/^the chain breaks between sequence 0 and 2/);
    expect(gapped.rows).toEqual([]);
    const short = await read(endpoint(real, forged));
    expect(short.problem).toBe("CounterAudit's signed checkpoint is at sequence 2, but the log read ends at sequence 1: it is not the whole log");
    expect(short.rows).toEqual([]);
  });

  it("keeps nothing past the signed head, though it hashes and links", async () => {
    const real = chain();
    // An approval sealed again after the rejection would be its reviewer's latest word.
    const appended = sealChain([APPROVAL], { prev: real[2].integrity.entry_hash, from: 3 });
    const result = await read(endpoint(real, [...real, ...appended]));
    expect(result.problem).toBeNull();
    expect(result.rows.map(r => r.sequence)).toEqual([0, 1, 2]);
    // What was listed past the head is not counted as listed, so a caller's count still adds up.
    expect(result.listed).toBe(3);
    expect(result.checkpoint?.sequence).toBe(2);
  });

  it("adds only what the head covers to what the Bureau already holds", async () => {
    const real = chain();
    const known = stored(real.slice(0, 2));
    const appended = sealChain([APPROVAL], { prev: real[2].integrity.entry_hash, from: 3 });
    const result = await read(endpoint(real, [...real, ...appended]), known);
    expect(result.problem).toBeNull();
    expect(result.rows.map(r => r.sequence)).toEqual([2]);
    expect(result.listed).toBe(3);
  });

  it("stops when the Bureau's copy already holds packets past the signed head", async () => {
    const real = chain();
    const result = await read(endpoint(real.slice(0, 2), real), stored(real));
    expect(result.problem).toMatch(/^the Bureau's copy holds packets past CounterAudit's signed checkpoint at sequence 1/);
    expect(result.rows).toEqual([]);
  });

  it("does not let a rewritten body through to one packet's reader", async () => {
    const real = chain();
    const { signed_event: _gone, ...emptied } = real[2];
    const good = await readReviewPacket(idOf(2), { apiUrl: API, readKey: "ca_read", fetch: endpoint(real) });
    expect(good).toMatchObject({ ok: true, sequence: 2, record: REJECTION });
    const bad = await readReviewPacket(idOf(2), { apiUrl: API, readKey: "ca_read", fetch: endpoint(real, [real[0], real[1], emptied as Packet]) });
    expect(bad).toEqual({ ok: false, reason: "it has a body that does not produce its payload hash" });
  });
});

describe("reading the Bureau's organization against the signed head", () => {
  const LINE = { furnisherId: "fur_levymerchant1", eventId: "charge-1", signedEventHash: "ab".repeat(32) };
  const seal = (status: "verified" | "needs_review") =>
    evidenceRecordFor(LINE, { verifier: null, status, reasons: [] } as never, NOW);
  const chain = () => sealChain([seal("needs_review"), seal("verified")], { connector: EVIDENCE_CONNECTOR_ID });
  const readOrg = (fetch: ReturnType<typeof endpoint>) =>
    readBureauOrganization({ apiUrl: API, readKey: "ca_read", orgId: ORG, fetch });

  it("takes the seal sealed last, up to the signed head", async () => {
    const got = await readOrg(endpoint(chain()));
    if ("problem" in got) throw new Error(got.problem);
    expect(sealFor(got.seals, LINE)?.packetId).toBe(idOf(1));
  });

  it("refuses a seal whose body was rewritten", async () => {
    const real = chain();
    const got = await readOrg(endpoint(real, [real[0], { ...real[1], signed_event: seal("needs_review") }]));
    expect(got).toEqual({ problem: `packet ${idOf(1)} has a body that does not produce its payload hash` });
  });

  describe("and an erased packet", () => {
    const placeOf = (p: Packet, n: number) => ({
      packetId: p.packet_id,
      sequence: n,
      entryHash: p.integrity.entry_hash,
      prevHash: p.integrity.prev_hash,
    });
    const three = () => sealChain([seal("needs_review"), seal("needs_review"), seal("verified")], { connector: EVIDENCE_CONNECTOR_ID });
    const HIDDEN = `CounterAudit says packet ${idOf(0)} is erased, without a tombstone it signed that shows it`;

    it("takes one with the tombstone CounterAudit signed", async () => {
      const real = three();
      const got = await readOrg(endpoint(real, real, { [idOf(0)]: tombstoneOf(ORG, placeOf(real[0], 0)) }));
      if ("problem" in got) throw new Error(got.problem);
      expect(sealFor(got.seals, LINE)?.packetId).toBe(idOf(2));
    });

    it("takes a tombstone signed before they named the previous hash", async () => {
      const real = three();
      const { prevHash: _prev, ...place } = placeOf(real[0], 0);
      const got = await readOrg(endpoint(real, real, { [idOf(0)]: tombstoneOf(ORG, place) }));
      expect("problem" in got).toBe(false);
    });

    it("refuses a live packet called erased, with nothing signed", async () => {
      const real = three();
      expect(await readOrg(endpoint(real, real, { [idOf(0)]: undefined }))).toEqual({ problem: HIDDEN });
    });

    it("refuses a tombstone that is unsigned, edited, or signed for something else", async () => {
      const real = three();
      const good = tombstoneOf(ORG, placeOf(real[0], 0));
      const others = [
        { ...good, signature: null },
        { ...good, expired_at: "2029-01-01T00:00:00.000Z" },
        tombstoneOf("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", placeOf(real[0], 0)),
        tombstoneOf(ORG, { ...placeOf(real[0], 0), packetId: idOf(9) }),
        tombstoneOf(ORG, { ...placeOf(real[0], 0), entryHash: "ab".repeat(32) }),
        tombstoneOf(ORG, { ...placeOf(real[0], 0), prevHash: "ab".repeat(32) }),
      ];
      for (const tombstone of others) {
        expect(await readOrg(endpoint(real, real, { [idOf(0)]: tombstone }))).toEqual({ problem: HIDDEN });
      }
    });

    it("refuses one signed for another place in the chain than the walk finds it", async () => {
      const real = three();
      const got = await readOrg(endpoint(real, real, { [idOf(0)]: tombstoneOf(ORG, { ...placeOf(real[0], 0), sequence: 7 }) }));
      expect(got).toEqual({
        problem: `packet ${idOf(0)} says it is at sequence 7, which is not its place in the chain to CounterAudit's signed head`,
      });
    });

    it("takes when a packet went from the tombstone, not the listing", async () => {
      const real = sealChain([{ schema: "x" }, seal("verified")], { connector: DISPUTE_CONNECTOR_ID });
      const signedAt = "2027-03-04T05:06:07.000Z";
      const got = await readOrg(endpoint(real, real, { [idOf(0)]: tombstoneOf(ORG, { ...placeOf(real[0], 0), expiredAt: signedAt }) }));
      if ("problem" in got) throw new Error(got.problem);
      expect(got.erasedDisputes.map(d => d.erasedAt?.toISOString())).toEqual([signedAt]);
    });

    it("does not let a forged history stand below an erased packet", async () => {
      const real = three();
      // Below the erased packet, its own hashes and links hold, but it is not what was sealed.
      const forged = sealChain([seal("verified")], { connector: EVIDENCE_CONNECTOR_ID, idFrom: 50 });
      const rewired = { ...real[1], integrity: { ...real[1].integrity, prev_hash: forged[0].integrity.entry_hash } };
      const got = await readOrg(endpoint(real, [forged[0], rewired, real[2]], { [idOf(1)]: tombstoneOf(ORG, placeOf(real[1], 1)) }));
      expect(got).toEqual({ problem: `CounterAudit says packet ${idOf(1)} is erased, without a tombstone it signed that shows it` });
    });
  });

  it("does not count a seal past the signed head, though it hashes and links", async () => {
    const real = chain();
    const appended = sealChain([seal("needs_review")], { connector: EVIDENCE_CONNECTOR_ID, prev: real[1].integrity.entry_hash, from: 2 });
    const got = await readOrg(endpoint(real, [...real, ...appended]));
    if ("problem" in got) throw new Error(got.problem);
    expect(sealFor(got.seals, LINE)?.packetId).toBe(idOf(1));
  });
});
