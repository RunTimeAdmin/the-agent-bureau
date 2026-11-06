import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  VECTORS_PATH,
  evidenceVectorsText,
  type EvidenceVectors,
} from "../scripts/evidence-vectors";
import type { EvidenceResult } from "./evidence";
import {
  EVIDENCE_CONNECTOR_ID,
  checkEvidenceRecord,
  evidenceRecordFor,
  readEvidenceSeals,
  sealFor,
  type EvidenceRecord,
} from "./evidenceSeal";
import { evidenceDigest } from "./reviewDecision";

// CounterAudit's checkpoints and head attestations in these fakes are signed with a key made for the
// test run (server/testCheckpoint.ts); the pinned keys gain it in this file only.
// These fakes make up their packets' hashes; server/packetHash.test.ts runs the real check.
vi.mock("./packetHash", () => ({ packetHashProblem: () => null }));
vi.mock("./counterauditKeys", async importOriginal => {
  const actual = await importOriginal<typeof import("./counterauditKeys")>();
  const { TEST_EXPORT_KEY } = await import("./testCheckpoint");
  return { COUNTERAUDIT_EXPORT_KEYS: { keys: [...actual.COUNTERAUDIT_EXPORT_KEYS.keys, TEST_EXPORT_KEY] } };
});
import { attestationOf, chainOf, checkpointOf, checkpointResponse } from "./testCheckpoint";

// The evidence records' shared vectors, which CounterAudit's agent-bureau-evidence-v1 connector
// runs against its own form check. Line endings normalized, so a checkout that writes CRLF still
// matches.
const text = readFileSync(VECTORS_PATH, "utf8").replace(/\r\n/g, "\n");
const vectors = JSON.parse(text) as EvidenceVectors;

describe("the evidence records' shared vectors", () => {
  it("are what scripts/evidence-vectors.ts builds (rebuild with pnpm evidence:vectors)", () => {
    expect(text).toBe(evidenceVectorsText());
  });

  it.each(vectors.valid.map(v => [v.id, v] as const))("valid: %s passes the form check", (_id, v) => {
    expect(checkEvidenceRecord(v.record)).toEqual({ ok: true, record: v.record });
  });

  it.each(vectors.invalid.map(v => [v.id, v] as const))("invalid: %s breaks the rule it names", (_id, v) => {
    expect(checkEvidenceRecord(v.record)).toEqual({ ok: false, reason: v.rule });
  });
});

const LINE = {
  furnisherId: "fur_levymerchant1",
  eventId: "charge-1",
  signedEventHash: "ab".repeat(32),
};
const CHARGE = {
  kind: "charged",
  chain: "arc-testnet",
  chain_id: 5042002,
  tx_hash: `0x${"c".repeat(64)}`,
  log_index: 14,
};

describe("evidenceRecordFor", () => {
  it("records the result's digest, status and whether an approval must waive something", () => {
    const at = new Date("2026-11-02T12:00:00.000Z");
    const verified = { verifier: null, status: "verified", reasons: [] } as EvidenceResult;
    expect(evidenceRecordFor(LINE, verified, at)).toEqual({
      schema: "agent-bureau/evidence-result/v1",
      furnisher_id: LINE.furnisherId,
      event_id: LINE.eventId,
      signed_event_hash: LINE.signedEventHash,
      evidence_digest: evidenceDigest(verified),
      status: "verified",
      needs_waiver: false,
      checked_at: "2026-11-02T12:00:00.000Z",
    });
    const settled = (screen?: string) =>
      ({
        ...verified,
        charge: CHARGE,
        ...(screen ? { funding_screen: { screen: "arc-funding/1", result: screen, flags: [], gaps: [] } } : {}),
      }) as unknown as EvidenceResult;
    expect(evidenceRecordFor(LINE, settled("clear"), at).needs_waiver).toBe(false);
    expect(evidenceRecordFor(LINE, settled("flagged"), at).needs_waiver).toBe(true);
    expect(evidenceRecordFor(LINE, settled(), at).needs_waiver).toBe(true);
    const review = { ...verified, status: "needs_review" } as EvidenceResult;
    expect(evidenceRecordFor(LINE, review, at).needs_waiver).toBe(true);
    for (const result of [verified, settled("clear"), review]) {
      expect(checkEvidenceRecord(evidenceRecordFor(LINE, result, at)).ok).toBe(true);
    }
  });
});

describe("readEvidenceSeals", () => {
  const ORG = "4702bb18-c7e5-4cfc-93e2-e0eab848e5c1";
  const record = (changes: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
    ...evidenceRecordFor(LINE, { verifier: null, status: "verified", reasons: [] }, new Date("2026-11-02T12:00:00.000Z")),
    ...changes,
  });
  const id = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  type Packet = {
    packet_id: string;
    connector_id: string;
    org_id?: string;
    sequence?: unknown;
    signed_event?: unknown;
    created_at?: string;
    expired_at?: string;
  };
  // CounterAudit's checkpoint, list and verify routes over these packets, placed in a whole chain
  // with ordinary packets between (chainOf), two to a page. `hide` leaves packets out of the
  // listing; `checkpoint` answers the checkpoint route in place of a signed, current head.
  function counterAudit(
    packets: Packet[],
    answers: Record<string, Response> = {},
    options: {
      hide?: string[];
      checkpoint?: (nonce: string | null) => Response;
      // What the listing alone says of a packet, whatever it is: another connector or packet id.
      relabel?: Record<string, { connector_id?: string; packet_id?: string }>;
      listStatus?: number;
    } = {}
  ) {
    const { packets: chain, tip } = chainOf(ORG, packets);
    const listed = chain
      .filter(p => !(options.hide ?? []).includes(p.packet_id))
      .map(p => ({ ...p, ...(options.relabel?.[p.packet_id] ?? {}) }));
    return vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === `/v1/audit/chain/${ORG}/checkpoint`) {
        const nonce = u.searchParams.get("nonce");
        return options.checkpoint ? options.checkpoint(nonce) : checkpointResponse(ORG, tip, nonce);
      }
      if (u.pathname === "/v1/audit/packets") {
        if (options.listStatus) return Response.json({ error: "refused" }, { status: options.listStatus });
        const from = Number(u.searchParams.get("cursor") ?? 0);
        const page = listed.slice(from, from + 2);
        return Response.json({
          packets: page.map(p => ({
            packet_id: p.packet_id,
            connector_id: p.connector_id,
            created_at: p.created_at,
            expired_at: (p as Packet).expired_at ?? null,
            ...("entry_hash" in p ? { prev_hash: p.prev_hash, entry_hash: p.entry_hash } : {}),
          })),
          next_cursor: from + 2 < listed.length ? String(from + 2) : null,
        });
      }
      const packetId = u.pathname.split("/").at(-1)!;
      if (answers[packetId]) return answers[packetId];
      const packet = chain.find(p => p.packet_id === packetId);
      return packet
        ? Response.json({ valid: true, packet: { org_id: ORG, ...packet } })
        : Response.json({ error: "not_found" }, { status: 404 });
    });
  }
  const read = (fetch: ReturnType<typeof counterAudit>) =>
    readEvidenceSeals({ apiUrl: "https://api.counteraudit.test", readKey: "ca_read", orgId: ORG, fetch });
  // Sealed at a time that follows its sequence.
  const sealed = (n: number, sequence: number, changes: Partial<EvidenceRecord> = {}): Packet => ({
    packet_id: id(n),
    connector_id: EVIDENCE_CONNECTOR_ID,
    sequence,
    signed_event: record(changes),
    created_at: new Date(Date.UTC(2026, 10, 2, 12, 0, sequence)).toISOString(),
  });

  it("keeps the record sealed last for each line, across pages, reading every packet through its verify route", async () => {
    const fetch = counterAudit([
      sealed(1, 5, { evidence_digest: "11".repeat(32) }),
      { packet_id: id(2), connector_id: "agent-bureau-outcome-v1", sequence: 2 },
      sealed(3, 9, { evidence_digest: "33".repeat(32) }),
      sealed(4, 7, { evidence_digest: "44".repeat(32) }),
      sealed(5, 6, { signed_event_hash: "ef".repeat(32) }),
    ]);
    const got = await read(fetch);
    if ("problem" in got) throw new Error(got.problem);
    expect(sealFor(got.seals, LINE)).toMatchObject({ packetId: id(3), sequence: 9 });
    expect(sealFor(got.seals, LINE)?.record.evidence_digest).toBe("33".repeat(32));
    expect(got.seals.get("ef".repeat(32))?.packetId).toBe(id(5));
    // Every packet is read through its verify route, the outcome packet and the ones between too:
    // its place, hashes and connector are the verify route's, not the listing's.
    const verified = fetch.mock.calls.map(([url]) => new URL(url).pathname).filter(path => path.startsWith("/v1/audit/verify/"));
    expect(verified).toHaveLength(10);
    expect(verified).toContain(`/v1/audit/verify/${id(2)}`);
    // A seal for the same version under another furnisher or event does not count for this line.
    expect(sealFor(got.seals, { ...LINE, eventId: "charge-2" })).toBeUndefined();
  });

  it("leaves out records erased oldest first, and stops at anything else it cannot read or trust", async () => {
    // Erased by the retention policy, older than every seal still held: listed so, or answered 410.
    for (const older of [{ ...sealed(1, 5), expired_at: "2028-11-02T12:00:00.000Z" }, sealed(1, 5)]) {
      const erased = await read(
        counterAudit([older, sealed(2, 9)], { [id(1)]: Response.json({ error: "expired" }, { status: 410 }) })
      );
      if ("problem" in erased) throw new Error(erased.problem);
      expect(sealFor(erased.seals, LINE)?.packetId).toBe(id(2));
    }
    // A newer seal erased while an older one is held: the older could stand in for it.
    for (const newer of [{ ...sealed(2, 9), expired_at: "2028-11-02T12:00:00.000Z" }, sealed(2, 9)]) {
      const got = await read(
        counterAudit([sealed(1, 5), newer], { [id(2)]: Response.json({ error: "expired" }, { status: 410 }) })
      );
      expect("problem" in got && got.problem).toBe(
        "CounterAudit erased an evidence seal newer than one it still holds, so the seal held for a line may not be its last"
      );
    }

    // The listing may call a packet erased only when its verify route agrees.
    const notErased = await read(counterAudit([{ ...sealed(1, 5), expired_at: "2028-11-02T12:00:00.000Z" }, sealed(2, 9)]));
    expect("problem" in notErased && notErased.problem).toBe(
      `CounterAudit lists packet ${id(1)} as erased, but its verify route holds it`
    );

    const cases: [Packet[], Record<string, Response>, string][] = [
      [[sealed(1, 5)], { [id(1)]: Response.json({ error: "down" }, { status: 503 }) }, `could not verify packet ${id(1)} (503)`],
      [[{ ...sealed(1, 5), org_id: "11111111-2222-4333-8444-555555555555" }], {}, "is not a packet of the Bureau's organization"],
      [[{ ...sealed(1, 5), sequence: "5" }], {}, `evidence packet ${id(1)} has no sequence`],
      [[{ ...sealed(1, 5), signed_event: { ...record(), needs_waiver: "no" } }], {}, "does not hold an evidence record: needs_waiver is not true or false"],
      [[{ packet_id: "not-a-uuid", connector_id: EVIDENCE_CONNECTOR_ID }], {}, "listed a packet without a packet id"],
    ];
    for (const [packets, answers, said] of cases) {
      const got = await read(counterAudit(packets, answers));
      expect("problem" in got && got.problem).toContain(said);
    }
    const unlisted = await read(vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })));
    expect("problem" in unlisted && unlisted.problem).toBe(
      "CounterAudit answered 403 for the Bureau organization's signed checkpoint"
    );
    const listingRefused = await read(counterAudit([sealed(1, 5)], {}, { listStatus: 403 }));
    expect("problem" in listingRefused && listingRefused.problem).toBe(
      "CounterAudit answered 403 when listing the organization's packets"
    );
  });

  describe("held to CounterAudit's signed head (review AB-01, for seals)", () => {
    const problem = async (fetch: ReturnType<typeof counterAudit>) => {
      const got = await read(fetch);
      return "problem" in got ? got.problem : null;
    };

    it("refuses a listing that leaves out a newer seal, which would pass an older one off as the last", async () => {
      const packets = [sealed(1, 5, { evidence_digest: "11".repeat(32) }), sealed(2, 9, { evidence_digest: "22".repeat(32) })];
      expect(await problem(counterAudit(packets))).toBeNull();
      expect(await problem(counterAudit(packets, {}, { hide: [id(2)] }))).toBe(
        "CounterAudit's listing of the Bureau organization's packets leaves out sequence 9, at or below its signed head at sequence 9"
      );
      // An ordinary packet in the middle left out breaks the walk the same way.
      const { packets: chain } = chainOf(ORG, packets);
      expect(await problem(counterAudit(packets, {}, { hide: [chain[7].packet_id] }))).toBe(
        "CounterAudit's listing of the Bureau organization's packets leaves out sequence 7, at or below its signed head at sequence 9"
      );
    });

    it("refuses a seal that says it sits somewhere else than its place in the chain", async () => {
      const at5 = chainOf(ORG, [sealed(1, 5), sealed(2, 9)]).packets[5];
      const moved = Response.json({ valid: true, packet: { org_id: ORG, ...at5, sequence: 4 } });
      expect(await problem(counterAudit([sealed(1, 5), sealed(2, 9)], { [id(1)]: moved }))).toBe(
        `packet ${id(1)} says it is at sequence 4, which is not its place in the chain to CounterAudit's signed head`
      );
    });

    it("takes nothing from what the listing calls a packet: another connector, another id, or the same one twice", async () => {
      const packets = [sealed(1, 5, { evidence_digest: "11".repeat(32) }), sealed(2, 9, { evidence_digest: "22".repeat(32) })];
      // The newest seal listed as an ordinary packet still counts, as the verify route says what it is.
      const relabelled = await read(counterAudit(packets, {}, { relabel: { [id(2)]: { connector_id: "agent-bureau-outcome-v1" } } }));
      if ("problem" in relabelled) throw new Error(relabelled.problem);
      expect(sealFor(relabelled.seals, LINE)?.packetId).toBe(id(2));
      // Listed under an id that is not its own, or under the older seal's.
      const madeUp = "aaaaaaaa-0000-4000-8000-000000000000";
      expect(await problem(counterAudit(packets, {}, { relabel: { [id(2)]: { packet_id: madeUp } } }))).toBe(
        `CounterAudit could not verify packet ${madeUp} (404)`
      );
      expect(await problem(counterAudit(packets, {}, { relabel: { [id(2)]: { packet_id: id(1) } } }))).toBe(
        `CounterAudit listed packet ${id(1)} twice`
      );
    });

    it("leaves a seal past the head for the next read, since nothing signed covers it", async () => {
      // The head is read before the listing: a seal made in between is listed after it.
      const head = chainOf(ORG, [sealed(1, 5)]).tip!;
      const later = (nonce: string | null) => Response.json({ checkpoint: checkpointOf(ORG, head), attestation: attestationOf(ORG, head, nonce) });
      const got = await read(counterAudit([sealed(1, 5, { evidence_digest: "11".repeat(32) }), sealed(2, 6, { evidence_digest: "22".repeat(32) })], {}, { checkpoint: later }));
      if ("problem" in got) throw new Error(got.problem);
      expect(sealFor(got.seals, LINE)?.packetId).toBe(id(1));
    });

    it("needs the head attested over this read's nonce", async () => {
      const head = chainOf(ORG, [sealed(1, 5)]).tip!;
      const replayed = () => Response.json({ checkpoint: checkpointOf(ORG, head), attestation: attestationOf(ORG, head, "ab".repeat(16)) });
      expect(await problem(counterAudit([sealed(1, 5)], {}, { checkpoint: replayed }))).toBe(
        "the Bureau organization's head attestation answers another read's nonce: an old answer, replayed"
      );
      // Attested empty, then packets listed: nothing signed covers them yet.
      const empty = (nonce: string | null) => checkpointResponse(ORG, null, nonce);
      const since = await read(counterAudit([sealed(1, 0)], {}, { checkpoint: empty }));
      if ("problem" in since) throw new Error(since.problem);
      expect(since.seals.size).toBe(0);
      // An organization with no packets yet has no seals, and that is no problem.
      const none = await read(counterAudit([]));
      expect("seals" in none && none.seals.size).toBe(0);
    });
  });
});
