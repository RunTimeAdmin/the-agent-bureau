import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ReviewLogRecordRow } from "../drizzle/schema";

// The checkpoints below are signed with a key made for this run; the pinned keys gain it here only.
vi.mock("./counterauditKeys", async importOriginal => {
  const actual = await importOriginal<typeof import("./counterauditKeys")>();
  const { TEST_EXPORT_KEY } = await import("./testCheckpoint");
  return { COUNTERAUDIT_EXPORT_KEYS: { keys: [...actual.COUNTERAUDIT_EXPORT_KEYS.keys, TEST_EXPORT_KEY] } };
});

import {
  counterauditBase,
  parseHead,
  readReviewLog,
  submitReviewRecord,
} from "./reviewLogSync";
import { attestationOf, checkpointOf, checkpointResponse } from "./testCheckpoint";

const API = "https://api.counteraudit.test";
const ORG = "11111111-2222-4333-8444-555555555555";
const KEY = "ca_read_review";
const NOW = new Date("2026-10-31T13:00:00.000Z");
const ZERO = "0".repeat(64);
const idOf = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hashOf = (n: number) =>
  createHash("sha256").update(`packet ${n}`).digest("hex");

type Packet = {
  packet_id: string;
  org_id: string;
  sequence: number;
  connector_id: string;
  signed_event: unknown;
  integrity: { prev_hash: string; entry_hash: string };
  created_at: string;
};

// A review organization's chain of `count` packets, each linked to the one before.
function packets(count: number): Packet[] {
  return Array.from({ length: count }, (_, n) => ({
    packet_id: idOf(n),
    org_id: ORG,
    sequence: n,
    connector_id: "agent-bureau-review-v1",
    signed_event: { schema: "agent-bureau/review-decision/v1", n },
    integrity: {
      prev_hash: n === 0 ? ZERO : hashOf(n - 1),
      entry_hash: hashOf(n),
    },
    created_at: new Date(Date.UTC(2026, 9, 31, 12, n)).toISOString(),
  }));
}

type Tip = { sequence: number; entryHash: string; packetId: string };
const tipOf = (p: Packet): Tip => ({ sequence: p.sequence, entryHash: p.integrity.entry_hash, packetId: p.packet_id });

// CounterAudit's list (newest first, `page` at a time), verify and checkpoint routes. The
// checkpoint is signed for the chain's tip, with a head attestation over the request's nonce,
// unless `checkpoint` names another tip, is a Response, or makes one from the nonce.
function fakeCounterAudit(
  chain: Packet[],
  options: {
    page?: number;
    status?: Record<string, number>;
    checkpoint?: Tip | null | Response | ((nonce: string | null) => Response);
  } = {}
) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === `/v1/audit/chain/${ORG}/checkpoint`) {
      if (options.checkpoint instanceof Response) return options.checkpoint;
      if (typeof options.checkpoint === "function") return options.checkpoint(u.searchParams.get("nonce"));
      const tip = options.checkpoint !== undefined ? options.checkpoint : chain.length ? tipOf(chain[chain.length - 1]) : null;
      return checkpointResponse(ORG, tip, u.searchParams.get("nonce"));
    }
    if (u.pathname === "/v1/audit/packets") {
      const newestFirst = [...chain].reverse();
      const start = Number(u.searchParams.get("cursor") ?? 0);
      const size = options.page ?? Number(u.searchParams.get("limit"));
      const next = start + size < newestFirst.length ? String(start + size) : null;
      return Response.json({
        packets: newestFirst
          .slice(start, start + size)
          .map(p => ({ packet_id: p.packet_id })),
        next_cursor: next,
      });
    }
    const id = u.pathname.split("/").at(-1)!;
    if (options.status?.[id]) return new Response(null, { status: options.status[id] });
    const packet = chain.find(p => p.packet_id === id);
    if (!packet) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({
      valid: true,
      entry_hash: packet.integrity.entry_hash,
      packet,
    });
  });
}

const read = (
  fetch: ReturnType<typeof fakeCounterAudit>,
  known: ReviewLogRecordRow[] = []
) => readReviewLog({ apiUrl: API, readKey: KEY, orgId: ORG, known, fetch, now: NOW });

const stored = (rows: Awaited<ReturnType<typeof read>>["rows"]) =>
  rows.map((row, i) => ({ id: i + 1, ...row }) as ReviewLogRecordRow);

describe("reading the review log", () => {
  it("reads every packet across pages, in sequence order, linked from sequence 0", async () => {
    const chain = packets(5);
    chain[3].connector_id = "other-connector";
    const fetch = fakeCounterAudit(chain, { page: 2 });
    const { rows, problem } = await read(fetch);

    expect(problem).toBeNull();
    expect(rows.map(r => r.sequence)).toEqual([0, 1, 2, 3, 4]);
    // Every packet CounterAudit listed, across both pages.
    expect((await read(fetch)).listed).toBe(5);
    expect(rows[1]).toEqual({
      sequence: 1,
      packetId: idOf(1),
      prevHash: hashOf(0),
      entryHash: hashOf(1),
      connectorId: "agent-bureau-review-v1",
      sealedAt: new Date(chain[1].created_at),
      record: chain[1].signed_event,
      readAt: NOW,
    });
    // Another connector's packet keeps its place in the chain but holds no record.
    expect(rows[3]).toMatchObject({ connectorId: "other-connector", record: null });

    // The first call reads the signed checkpoint (below); the second lists.
    const [url, init] = fetch.mock.calls[1];
    expect(url).toBe(`${API}/v1/audit/packets?limit=100&refresh=1`);
    expect(init).toMatchObject({
      headers: { authorization: `Bearer ${KEY}` },
      redirect: "error",
    });
  });

  it("verifies only packets it does not hold yet, and links them to those it does", async () => {
    const chain = packets(4);
    const first = await read(fakeCounterAudit(chain.slice(0, 2)));
    const fetch = fakeCounterAudit(chain);
    const { rows, problem } = await read(fetch, stored(first.rows));

    expect(problem).toBeNull();
    expect(rows.map(r => r.sequence)).toEqual([2, 3]);
    const verified = fetch.mock.calls.map(([url]) => url).filter(url => url.includes("/verify/"));
    expect(verified).toEqual([`${API}/v1/audit/verify/${idOf(3)}`, `${API}/v1/audit/verify/${idOf(2)}`]);
  });

  it("stops at a missing packet and keeps what comes before it", async () => {
    const chain = packets(5).filter(p => p.sequence !== 2);
    const { rows, problem } = await read(fakeCounterAudit(chain));
    expect(rows.map(r => r.sequence)).toEqual([0, 1]);
    expect(problem).toBe("the chain breaks between sequence 1 and 3; read up to 1");
  });

  it("stops at a packet that does not link to the one before", async () => {
    const chain = packets(4);
    chain[2].integrity.prev_hash = hashOf(99);
    const { rows, problem } = await read(fakeCounterAudit(chain));
    expect(rows.map(r => r.sequence)).toEqual([0, 1]);
    expect(problem).toBe("the chain breaks between sequence 1 and 2; read up to 1");
  });

  it("refuses a log that does not start at sequence 0", async () => {
    const { rows, problem } = await read(fakeCounterAudit(packets(3).slice(1)));
    expect(rows).toEqual([]);
    expect(problem).toBe("the review log does not start at sequence 0 (its first packet is 1)");
  });

  it("stores nothing when a packet is another organization's, erased or does not verify", async () => {
    // The signed checkpoint still comes back, for the caller to record: the next read must reach it.
    const signedTip = {
      sequence: 2,
      entryHash: hashOf(2),
      packetId: idOf(2),
      issuedAt: new Date("2026-11-03T12:00:00.000Z"),
    };
    const foreign = packets(3);
    foreign[1].org_id = "99999999-2222-4333-8444-555555555555";
    expect(await read(fakeCounterAudit(foreign))).toEqual({
      rows: [],
      listed: 3,
      listedComplete: true,
      problem: `packet ${idOf(1)} belongs to another organization`,
      checkpoint: signedTip,
    });
    expect(await read(fakeCounterAudit(packets(3), { status: { [idOf(1)]: 410 } }))).toEqual({
      rows: [],
      listed: 3,
      listedComplete: true,
      problem: `packet ${idOf(1)} has been erased; the review log must keep every packet`,
      checkpoint: signedTip,
    });
    expect(await read(fakeCounterAudit(packets(3), { status: { [idOf(0)]: 409 } }))).toEqual({
      rows: [],
      listed: 3,
      listedComplete: true,
      problem: `CounterAudit could not verify packet ${idOf(0)} (409)`,
      checkpoint: signedTip,
    });
    // A verify answer for another packet than the one asked for.
    const swapped = fakeCounterAudit(packets(3));
    const answer = swapped.getMockImplementation()!;
    swapped.mockImplementation(async (url: string, init?: RequestInit) =>
      new URL(url).pathname.endsWith(idOf(1)) ? answer(url.replace(idOf(1), idOf(2)), init) : answer(url, init)
    );
    expect((await read(swapped)).problem).toBe(`CounterAudit answered for another packet than ${idOf(1)}`);
  });

  it("refuses an answer too large to be the review log's", async () => {
    const fetch = vi.fn(async () => new Response("x".repeat(2 * 1024 * 1024 + 1)));
    await expect(read(fetch as never)).rejects.toThrow("CounterAudit's answer is too large");
  });

  it("sends its key only over https, or plain http to this machine", () => {
    expect(counterauditBase("https://api.counteraudit.io/")).toBe("https://api.counteraudit.io");
    expect(counterauditBase("http://127.0.0.1:3001")).toBe("http://127.0.0.1:3001");
    for (const bad of [
      "http://api.counteraudit.io",
      "https://user:pass@api.counteraudit.io",
      "https://api.counteraudit.io/?x=1",
    ]) {
      expect(() => counterauditBase(bad)).toThrow("COUNTERAUDIT_API_URL");
    }
  });
});

describe("the signed head (review AB-01)", () => {
  it("refuses a valid prefix that says it is the whole log when the signed checkpoint is later", async () => {
    // A stale or dishonest endpoint lists sequences 0 to 2, linked and with no next page. Its own
    // signed checkpoint is at sequence 4, so the listing is short of it.
    const chain = packets(5);
    const result = await read(fakeCounterAudit(chain.slice(0, 3), { checkpoint: tipOf(chain[4]) }));
    expect(result.problem).toBe(
      "CounterAudit's signed checkpoint is at sequence 4, but the log read ends at sequence 2: it is not the whole log"
    );
    expect(result.listedComplete).toBe(true);
  });

  it("reads the checkpoint before the listing, and the listing past CounterAudit's cache", async () => {
    // A packet sealed between the two only makes the listing longer than the checkpoint.
    const chain = packets(5);
    const fetch = fakeCounterAudit(chain, { checkpoint: tipOf(chain[2]) });
    expect((await read(fetch)).problem).toBeNull();
    const urls = fetch.mock.calls.map(([url]) => new URL(url));
    expect(urls[0].pathname).toBe(`/v1/audit/chain/${ORG}/checkpoint`);
    const lists = urls.filter(u => u.pathname === "/v1/audit/packets");
    expect(lists.length).toBeGreaterThan(0);
    for (const u of lists) expect(u.searchParams.get("refresh")).toBe("1");
  });

  it("takes a log that reaches its signed checkpoint, and returns the checkpoint", async () => {
    const chain = packets(3);
    const result = await read(fakeCounterAudit(chain));
    expect(result.problem).toBeNull();
    expect(result.checkpoint).toEqual({
      sequence: 2,
      entryHash: hashOf(2),
      packetId: idOf(2),
      issuedAt: new Date("2026-11-03T12:00:00.000Z"),
    });
  });

  it("refuses a checkpoint whose signature does not verify, or that is for another organization", async () => {
    const chain = packets(3);
    const edited = { ...checkpointOf(ORG, tipOf(chain[2])), sequence: 9 };
    expect((await read(fakeCounterAudit(chain, { checkpoint: Response.json({ checkpoint: edited }) }))).problem).toBe(
      "the review log's checkpoint is not signed with CounterAudit's export key (digest_mismatch)"
    );
    const other = checkpointOf("99999999-2222-4333-8444-555555555555", tipOf(chain[2]));
    expect((await read(fakeCounterAudit(chain, { checkpoint: Response.json({ checkpoint: other }) }))).problem).toBe(
      "the review log's checkpoint is for another organization"
    );
    expect((await read(fakeCounterAudit(chain, { checkpoint: new Response(null, { status: 503 }) }))).problem).toBe(
      "CounterAudit answered 503 for the review log's signed checkpoint"
    );
  });

  it("refuses a log, or a checkpoint, short of a head already reached", async () => {
    const chain = packets(5);
    const reached = { sequence: 4, entryHash: hashOf(4) };
    const readWith = (fetch: ReturnType<typeof fakeCounterAudit>, minHead: { sequence: number; entryHash: string }) =>
      readReviewLog({ apiUrl: API, readKey: KEY, orgId: ORG, known: [], minHead, fetch, now: NOW });
    // A restored or stale log whose checkpoint went back with it.
    expect((await readWith(fakeCounterAudit(chain.slice(0, 3)), reached)).problem).toBe(
      "CounterAudit's signed checkpoint is at sequence 2, below sequence 4, which the review log has already reached: its head went back"
    );
    // A pinned head past what is listed, with a checkpoint that does not go back far enough to show it.
    expect((await readWith(fakeCounterAudit(chain, { checkpoint: tipOf(chain[4]) }), { sequence: 6, entryHash: hashOf(6) })).problem).toBe(
      "CounterAudit's signed checkpoint is at sequence 4, below sequence 6, which the review log has already reached: its head went back"
    );
    // A pinned head that names another packet than the one at its sequence.
    expect((await readWith(fakeCounterAudit(chain), { sequence: 2, entryHash: hashOf(99) })).problem).toBe(
      "the head already reached names another packet at sequence 2 than the log read holds"
    );
    expect((await readWith(fakeCounterAudit(chain), reached)).problem).toBeNull();
  });

  it("refuses a log with packets when CounterAudit gives no checkpoint for it (review of AB-01)", async () => {
    // A dishonest endpoint, or one without the route, answers "none yet" and lists a linked prefix.
    const chain = packets(5);
    const none = new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const result = await read(fakeCounterAudit(chain.slice(0, 3), { checkpoint: none }));
    expect(result.problem).toBe("CounterAudit's answer for the review log's head carries no attestation over this read's nonce");
    expect(result.checkpoint).toBeNull();
    // Attested empty, then listing packets: the first packet sealed between the two, or a lie.
    const empty = (nonce: string | null) => checkpointResponse(ORG, null, nonce);
    expect((await read(fakeCounterAudit(chain.slice(0, 3), { checkpoint: empty }))).problem).toBe(
      "CounterAudit gives no signed checkpoint for a review log it lists packets in"
    );
    const pinned = await readReviewLog({
      apiUrl: API, readKey: KEY, orgId: ORG, known: [], minHead: { sequence: 1, entryHash: hashOf(1) },
      fetch: fakeCounterAudit(chain.slice(0, 3), { checkpoint: empty }),
      now: NOW,
    });
    expect(pinned.problem).toBe("CounterAudit gives no signed checkpoint for a review log it lists packets in");
  });

  describe("the head attestation over this read's nonce", () => {
    const chain = packets(3);
    const tip = tipOf(chain[2]);
    // The checkpoint for `tip`, with an attestation made by `attest` from the request's nonce.
    const answer = (attest: (nonce: string | null) => Record<string, unknown> | null) => (nonce: string | null) => {
      const attestation = attest(nonce);
      return Response.json({ checkpoint: checkpointOf(ORG, tip), ...(attestation ? { attestation } : {}) });
    };

    it("takes a current attestation over its own nonce, and sends a new nonce each read", async () => {
      const fetch = fakeCounterAudit(chain);
      expect((await read(fetch)).problem).toBeNull();
      await read(fetch);
      const nonces = fetch.mock.calls
        .map(([url]) => new URL(url))
        .filter(u => u.pathname.endsWith("/checkpoint"))
        .map(u => u.searchParams.get("nonce"));
      expect(nonces).toHaveLength(2);
      for (const n of nonces) expect(n).toMatch(/^[0-9a-f]{32}$/);
      expect(nonces[0]).not.toBe(nonces[1]);
    });

    it("refuses an attestation over another read's nonce: an old answer replayed", async () => {
      const replayed = answer(() => attestationOf(ORG, tip, "ab".repeat(16)));
      expect((await read(fakeCounterAudit(chain, { checkpoint: replayed }))).problem).toBe(
        "the review log's head attestation answers another read's nonce: an old answer, replayed"
      );
    });

    it("refuses an answer with no attestation, or one not made during the read", async () => {
      expect((await read(fakeCounterAudit(chain, { checkpoint: answer(() => null) }))).problem).toBe(
        "CounterAudit's answer for the review log's head carries no attestation over this read's nonce"
      );
      const old = answer(nonce => attestationOf(ORG, tip, nonce, { served_at: "2026-11-01T00:00:00.000Z" }));
      expect((await read(fakeCounterAudit(chain, { checkpoint: old }))).problem).toBe(
        "the review log's head attestation was not made during this read"
      );
    });

    it("refuses an attestation that does not call the checkpoint the head, naming why", async () => {
      const cut = answer(nonce => attestationOf(ORG, tip, nonce, { current: false, reason: "chain_forked", tip_sequence: 2 }));
      expect((await read(fakeCounterAudit(chain, { checkpoint: cut }))).problem).toBe(
        "CounterAudit does not attest its newest checkpoint as the review log's head (chain_forked)"
      );
      // Only a plain reason name is printed.
      const odd = answer(nonce => attestationOf(ORG, tip, nonce, { current: false, reason: "see https://example.test" }));
      expect((await read(fakeCounterAudit(chain, { checkpoint: odd }))).problem).toBe(
        "CounterAudit does not attest its newest checkpoint as the review log's head (no reason given)"
      );
    });

    it("asks once more when packets kept arriving while CounterAudit answered", async () => {
      let asked = 0;
      const moving = answer(nonce =>
        ++asked === 1 ? attestationOf(ORG, tip, nonce, { current: false, reason: "tip_moved", tip_sequence: 3 }) : attestationOf(ORG, tip, nonce)
      );
      expect((await read(fakeCounterAudit(chain, { checkpoint: moving }))).problem).toBeNull();
      expect(asked).toBe(2);
      const stillMoving = answer(nonce => attestationOf(ORG, tip, nonce, { current: false, reason: "tip_moved", tip_sequence: 3 }));
      expect((await read(fakeCounterAudit(chain, { checkpoint: stillMoving }))).problem).toBe(
        "CounterAudit does not attest its newest checkpoint as the review log's head (tip_moved)"
      );
    });

    it("refuses an attestation of another head than the checkpoint beside it", async () => {
      const other = answer(nonce => attestationOf(ORG, tipOf(chain[1]), nonce));
      expect((await read(fakeCounterAudit(chain, { checkpoint: other }))).problem).toBe(
        "the review log's head attestation names another head than the checkpoint in the same answer"
      );
      // An empty-chain answer must attest an empty chain.
      const emptyButNot = (nonce: string | null) =>
        Response.json({ error: "not_found", attestation: attestationOf(ORG, null, nonce, { tip_sequence: 2 }) }, { status: 404 });
      expect((await read(fakeCounterAudit([], { checkpoint: emptyButNot }))).problem).toBe(
        "the review log's head attestation names another head than the checkpoint in the same answer"
      );
    });

    it("checks the signature only against the pinned key, whatever key the answer names", async () => {
      const elsewhere = answer(nonce => {
        const signed = attestationOf(ORG, tip, nonce);
        const signature = signed.signature as Record<string, unknown>;
        return {
          ...signed,
          signature: { ...signature, key_id: "attacker-key", verification_key_url: "https://attacker.test/jwks.json" },
        };
      });
      expect((await read(fakeCounterAudit(chain, { checkpoint: elsewhere }))).problem).toBe(
        "the review log's head attestation is not signed with CounterAudit's export key (missing_public_key)"
      );
      const forOther = answer(nonce => attestationOf("99999999-2222-4333-8444-555555555555", tip, nonce));
      expect((await read(fakeCounterAudit(chain, { checkpoint: forOther }))).problem).toBe(
        "the review log's head attestation is for another organization"
      );
    });
  });

  it("refuses a checkpoint that names another packet at its sequence, and returns none to record", async () => {
    const chain = packets(3);
    const otherId = { ...tipOf(chain[2]), packetId: "aaaaaaaa-2222-4333-8444-555555555555" };
    const result = await read(fakeCounterAudit(chain, { checkpoint: otherId }));
    expect(result.problem).toBe("CounterAudit's signed checkpoint names another packet at sequence 2 than the log read holds");
    expect(result.checkpoint).toBeNull();
  });

  it("returns a checkpoint whose signature block is malformed as unsigned, not as an error", async () => {
    const chain = packets(3);
    const signed = checkpointOf(ORG, tipOf(chain[2]));
    const broken = { ...signed, signature: { ...signed.signature, proof: "not an object" } };
    const result = await read(fakeCounterAudit(chain, { checkpoint: Response.json({ checkpoint: broken }) }));
    expect(result.problem).toMatch(/^the review log's checkpoint is not signed with CounterAudit's export key/);
  });

  it("takes an empty log, which has no checkpoint yet, unless a head was already reached", async () => {
    expect(await read(fakeCounterAudit([]))).toEqual({ rows: [], listed: 0, listedComplete: true, problem: null, checkpoint: null });
    const reached = await readReviewLog({
      apiUrl: API, readKey: KEY, orgId: ORG, known: [], minHead: { sequence: 0, entryHash: hashOf(0) },
      fetch: fakeCounterAudit([]), now: NOW,
    });
    expect(reached.problem).toBe("the head already reached is at sequence 0, but the log read ends before sequence 0: it is not the whole log");
  });

  it("reads a pinned head as sequence:entryhash", () => {
    expect(parseHead(`4:${hashOf(4)}`)).toEqual({ sequence: 4, entryHash: hashOf(4) });
    expect(parseHead(`4:${hashOf(4).toUpperCase()}`)).toBeNull();
    expect(parseHead("4")).toBeNull();
  });
});

describe("sealing a record", () => {
  const record = { schema: "agent-bureau/review-decision/v1", reviewer_id: "rev_alice" };

  it("posts the record whole under the review connector with the reviewer's own key", async () => {
    const receipt = { packet_id: idOf(7), signature: "sig" };
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ packet_id: idOf(7), sequence: 7, receipt }, { status: 201 })
    );
    expect(await submitReviewRecord(record, { apiUrl: API, ingestKey: "ca_ingest_alice", fetch })).toEqual({
      ok: true,
      packetId: idOf(7),
      sequence: 7,
      created: true,
      receipt,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${API}/v1/audit/ingest`);
    expect(init).toMatchObject({ method: "POST", headers: { authorization: "Bearer ca_ingest_alice" } });
    expect(JSON.parse(String(init!.body))).toEqual({ connector_id: "agent-bureau-review-v1", raw_event: record });
  });

  it("says when the record was sealed before", async () => {
    const fetch = vi.fn(async () => Response.json({ packet_id: idOf(7), sequence: 7 }, { status: 200 }));
    expect(await submitReviewRecord(record, { apiUrl: API, ingestKey: "k", fetch })).toMatchObject({ ok: true, created: false });
  });

  it("passes on CounterAudit's refusal", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: "review_record_invalid", message: "decided_at must be an ISO time" }, { status: 422 })
    );
    expect(await submitReviewRecord(record, { apiUrl: API, ingestKey: "k", fetch })).toEqual({
      ok: false,
      reason: "CounterAudit refused it (422 review_record_invalid: decided_at must be an ISO time)",
    });
  });
});
