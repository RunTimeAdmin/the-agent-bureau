// Reading an upstream answer without trusting its size (review of 11 November:
// the CounterAudit client and the chain readers parsed whatever came back).
// Bytes are counted after decompression, as fetch hands them over, and reading
// stops at the cap, so an oversized answer costs at most that much memory.

/** The body as text, or null when it is larger than maxBytes (the rest is not read). */
export async function readCappedText(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * A fetch for viem's http transport (its fetchFn) that reads each answer up to
 * maxBytes and throws past it, so the read fails closed instead of parsing it.
 */
export function cappedFetch(maxBytes: number, inner: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    const res = await inner(input, init);
    const text = await readCappedText(res, maxBytes);
    if (text === null) throw new Error(`the RPC answer is larger than ${maxBytes} bytes`);
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(text, { status: res.status, statusText: res.statusText, headers });
  };
}
