import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ReviewLogRecordRow } from "../drizzle/schema";
import {
  counterauditBase,
  readReviewLog,
  submitReviewRecord,
} from "./reviewLogSync";

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

// CounterAudit's list (newest first, `page` at a time) and verify routes.
function fakeCounterAudit(
  chain: Packet[],
  options: { page?: number; status?: Record<string, number> } = {}
) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const u = new URL(url);
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

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${API}/v1/audit/packets?limit=100`);
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
    const foreign = packets(3);
    foreign[1].org_id = "99999999-2222-4333-8444-555555555555";
    expect(await read(fakeCounterAudit(foreign))).toEqual({
      rows: [],
      listed: 3,
      problem: `packet ${idOf(1)} belongs to another organization`,
    });
    expect(await read(fakeCounterAudit(packets(3), { status: { [idOf(1)]: 410 } }))).toEqual({
      rows: [],
      listed: 3,
      problem: `packet ${idOf(1)} has been erased; the review log must keep every packet`,
    });
    expect(await read(fakeCounterAudit(packets(3), { status: { [idOf(0)]: 409 } }))).toEqual({
      rows: [],
      listed: 3,
      problem: `CounterAudit could not verify packet ${idOf(0)} (409)`,
    });
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
