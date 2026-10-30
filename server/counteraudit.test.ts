import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchJwks,
  fetchProof,
  ingestSignedEvent,
  resetJwksCache,
} from "./counteraudit";

const fetchMock = vi.fn();

const event = { schema_version: "1", furnisher_id: "fur_e2etest01" };

const sealedBody = {
  packet_id: "6a311b56-bf03-43cd-86b2-9357f5685080",
  entry_hash:
    "2eaff3236ebd1029f69fb3676a3dd01a3639d83b3b3464d908498027d9f0b85c",
  sequence: 0,
  created_at: "2026-10-30T18:55:04.529Z",
  raw_event_hash:
    "03f35cc5010de574edec92f428af1039f8f2181c5e31ae4ef7e13e10a24e4200",
  receipt: { receipt_type: "counteraudit.packet_receipt" },
};

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("COUNTERAUDIT_API_URL", "https://ca.example/");
  vi.stubEnv("COUNTERAUDIT_INGEST_KEY", "ca_test_ingest_key");
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetJwksCache();
});

describe("ingestSignedEvent", () => {
  it("sends the event to the furnish connector with a public proof", async () => {
    fetchMock.mockResolvedValueOnce(respond(201, sealedBody));
    await ingestSignedEvent(event);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ca.example/v1/audit/ingest");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer ca_test_ingest_key");
    expect(JSON.parse(init.body)).toEqual({
      connector_id: "agent-bureau-outcome-v1",
      raw_event: event,
      public_proof: true,
    });
  });

  it("returns a sealed packet for 201", async () => {
    fetchMock.mockResolvedValueOnce(respond(201, sealedBody));
    expect(await ingestSignedEvent(event)).toEqual({
      kind: "sealed",
      status: 201,
      packet: sealedBody,
    });
  });

  it("returns the existing packet for 200", async () => {
    fetchMock.mockResolvedValueOnce(
      respond(200, { ...sealedBody, idempotent: true })
    );
    expect(await ingestSignedEvent(event)).toEqual({
      kind: "already_sealed",
      status: 200,
      packet: sealedBody,
    });
  });

  it("returns a conflict for 409 outcome_event_conflict", async () => {
    fetchMock.mockResolvedValueOnce(
      respond(409, {
        error: "outcome_event_conflict",
        message: "fur_e2etest01 already sealed a different event",
      })
    );
    expect(await ingestSignedEvent(event)).toEqual({
      kind: "conflict",
      status: 409,
      error: "outcome_event_conflict",
      message: "fur_e2etest01 already sealed a different event",
    });
  });

  it.each([
    "outcome_schema_invalid",
    "outcome_signer_unknown",
    "outcome_signature_invalid",
  ])("returns a refusal for 422 %s", async code => {
    fetchMock.mockResolvedValueOnce(
      respond(422, { error: code, message: "refused" })
    );
    expect(await ingestSignedEvent(event)).toEqual({
      kind: "refused",
      status: 422,
      error: code,
      message: "refused",
    });
  });

  it("returns a failure, not a throw, when the network fails", async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") })
    );
    const result = await ingestSignedEvent(event);
    expect(result).toEqual({
      kind: "failed",
      status: null,
      error: "network_error",
      message: "fetch failed (ECONNREFUSED)",
    });
  });

  it("treats a 201 without packet fields as a failure", async () => {
    fetchMock.mockResolvedValueOnce(respond(201, { ok: true }));
    const result = await ingestSignedEvent(event);
    expect(result).toMatchObject({
      kind: "failed",
      status: 201,
      error: "unexpected_response",
    });
  });

  it("reports other statuses with CounterAudit's error code", async () => {
    fetchMock.mockResolvedValueOnce(
      respond(401, { error: "unauthorized", message: "Invalid API key" })
    );
    const result = await ingestSignedEvent(event);
    expect(result).toEqual({
      kind: "failed",
      status: 401,
      error: "unauthorized",
      message: "Invalid API key",
    });
    expect(JSON.stringify(result)).not.toContain("ca_test_ingest_key");
  });

  it("sends nothing without an ingest key", async () => {
    vi.stubEnv("COUNTERAUDIT_INGEST_KEY", "");
    const result = await ingestSignedEvent(event);
    expect(result).toMatchObject({ kind: "failed", error: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchProof", () => {
  it("fetches the public proof without a key", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { packet_id: "p" }));
    const result = await fetchProof("6a311b56-bf03-43cd-86b2-9357f5685080");
    expect(result).toEqual({ ok: true, proof: { packet_id: "p" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://ca.example/v1/proofs/6a311b56-bf03-43cd-86b2-9357f5685080"
    );
    expect(init.headers.authorization).toBeUndefined();
  });

  it("reports a missing proof", async () => {
    fetchMock.mockResolvedValueOnce(
      respond(404, { error: "not_found", message: "No public proof" })
    );
    expect(await fetchProof("x")).toEqual({
      ok: false,
      status: 404,
      message: "No public proof",
    });
  });
});

describe("fetchJwks", () => {
  const jwks = {
    keys: [{ kty: "OKP", crv: "Ed25519", x: "abc", kid: "k1" }],
  };

  it("fetches the export keys once and serves later calls from cache", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, jwks));
    expect(await fetchJwks()).toEqual({ ok: true, jwks });
    expect(await fetchJwks()).toEqual({ ok: true, jwks });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://ca.example/.well-known/counteraudit-export-jwk.json"
    );
  });

  it("does not cache a failure", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(503, { error: "unavailable" }))
      .mockResolvedValueOnce(respond(200, jwks));
    expect(await fetchJwks()).toMatchObject({ ok: false });
    expect(await fetchJwks()).toEqual({ ok: true, jwks });
  });
});
