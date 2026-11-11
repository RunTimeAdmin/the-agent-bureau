import { describe, expect, it, vi } from "vitest";
import { cappedFetch, readCappedText } from "./cappedBody";

// A body that arrives in chunks and declares no length, as a chunked or
// compressed answer does.
function streamed(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status });
}

describe("readCappedText", () => {
  it("reads an answer up to the cap", async () => {
    await expect(readCappedText(streamed(["{\"a\":", "1}"]), 7)).resolves.toBe("{\"a\":1}");
  });

  it("stops past the cap, however the answer is split", async () => {
    await expect(readCappedText(streamed(["{\"a\":", "1}"]), 6)).resolves.toBeNull();
  });

  it("refuses an answer whose declared length is over the cap without reading it", async () => {
    const res = new Response("x".repeat(10), { headers: { "content-length": "10" } });
    await expect(readCappedText(res, 9)).resolves.toBeNull();
  });
});

describe("cappedFetch", () => {
  it("passes an answer under the cap through, status and body", async () => {
    const inner = vi.fn(async () => streamed(["{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}"], 200));
    const res = await cappedFetch(1024, inner)("https://rpc.example", { method: "POST" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: "0x1" });
  });

  // Review of 11 November: the chain readers parsed whatever the RPC sent.
  it("throws on an answer over the cap, so the read fails closed", async () => {
    const inner = vi.fn(async () => streamed(["x".repeat(600), "x".repeat(600)]));
    await expect(cappedFetch(1024, inner)("https://rpc.example")).rejects.toThrow("larger than 1024 bytes");
  });
});
