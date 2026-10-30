// Client for CounterAudit, the system of record for furnished outcome events.
// Only the operator intake script (scripts/furnish-intake.ts) calls it. No
// route of this server uses it, and nothing here accepts an event from
// outside. See docs/counteraudit-intake.md.
import { ENV } from "./_core/env";
import { FURNISH_CONNECTOR_ID, isRecord, type Jwks } from "./outcomeProof";

const TIMEOUT_MS = 15_000;
// CounterAudit serves its export keys with Cache-Control: max-age=3600.
const JWKS_TTL_MS = 60 * 60 * 1000;

function baseUrl(): string {
  return ENV.counterauditApiUrl.replace(/\/+$/, "");
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error.message}${cause}`;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function errorFields(body: unknown): { error: string; message: string } {
  const fields = isRecord(body) ? body : {};
  return {
    error: typeof fields.error === "string" ? fields.error : "unknown_error",
    message: typeof fields.message === "string" ? fields.message : "",
  };
}

/** What CounterAudit sealed, from its ingest answer. */
export type SealedPacket = {
  packet_id: string;
  entry_hash: string;
  sequence: number | null;
  created_at: string;
  raw_event_hash: string;
  /** CounterAudit's signed receipt; null if it sent none. */
  receipt: Record<string, unknown> | null;
};

function readSealedPacket(body: unknown): SealedPacket | null {
  if (!isRecord(body)) return null;
  const { packet_id, entry_hash, sequence, created_at, raw_event_hash } = body;
  if (
    typeof packet_id !== "string" ||
    typeof entry_hash !== "string" ||
    typeof created_at !== "string" ||
    Number.isNaN(Date.parse(created_at)) ||
    typeof raw_event_hash !== "string" ||
    !(sequence === null || sequence === undefined || Number.isInteger(sequence))
  ) {
    return null;
  }
  return {
    packet_id,
    entry_hash,
    sequence: typeof sequence === "number" ? sequence : null,
    created_at,
    raw_event_hash,
    receipt: isRecord(body.receipt) ? body.receipt : null,
  };
}

/** The 422 codes CounterAudit gives a refused furnish v1 event. */
export type RefusalCode =
  | "outcome_schema_invalid"
  | "outcome_signer_unknown"
  | "outcome_signature_invalid";

const REFUSAL_CODES: readonly string[] = [
  "outcome_schema_invalid",
  "outcome_signer_unknown",
  "outcome_signature_invalid",
];

function isRefusalCode(code: string): code is RefusalCode {
  return REFUSAL_CODES.includes(code);
}

export type IngestResult =
  /** 201: newly sealed. */
  | { kind: "sealed"; status: 201; packet: SealedPacket }
  /** 200: this exact event was sealed before; its packet comes back. */
  | { kind: "already_sealed"; status: 200; packet: SealedPacket }
  /** 409: the furnisher already used this event_id for a different event. */
  | {
      kind: "conflict";
      status: 409;
      error: "outcome_event_conflict";
      message: string;
    }
  /** 422: refused (schema, unknown signer or bad signature); nothing sealed. */
  | { kind: "refused"; status: 422; error: RefusalCode; message: string }
  /** Anything else, including no answer at all. Nothing is known sealed. */
  | { kind: "failed"; status: number | null; error: string; message: string };

/**
 * Sends one signed furnish v1 event to CounterAudit to be sealed, with a
 * public proof so a file line can link to it.
 */
export async function ingestSignedEvent(
  event: Record<string, unknown>
): Promise<IngestResult> {
  const key = ENV.counterauditIngestKey;
  if (!key) {
    return {
      kind: "failed",
      status: null,
      error: "not_configured",
      message: "COUNTERAUDIT_INGEST_KEY is not set",
    };
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/v1/audit/ingest`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        connector_id: FURNISH_CONNECTOR_ID,
        raw_event: event,
        public_proof: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      kind: "failed",
      status: null,
      error: "network_error",
      message: describeError(error),
    };
  }
  const body = await readJson(res);
  if (res.status === 201 || res.status === 200) {
    const packet = readSealedPacket(body);
    if (!packet) {
      return {
        kind: "failed",
        status: res.status,
        error: "unexpected_response",
        message: "CounterAudit's answer is missing the packet fields",
      };
    }
    return res.status === 201
      ? { kind: "sealed", status: 201, packet }
      : { kind: "already_sealed", status: 200, packet };
  }
  const { error, message } = errorFields(body);
  if (res.status === 409 && error === "outcome_event_conflict") {
    return { kind: "conflict", status: 409, error, message };
  }
  if (res.status === 422 && isRefusalCode(error)) {
    return { kind: "refused", status: 422, error, message };
  }
  return { kind: "failed", status: res.status, error, message };
}

export type ProofResult =
  | { ok: true; proof: Record<string, unknown> }
  | { ok: false; status: number | null; message: string };

/** GET /v1/proofs/{packet_id}. Public: no key is sent. */
export async function fetchProof(packetId: string): Promise<ProofResult> {
  let res: Response;
  try {
    res = await fetch(
      `${baseUrl()}/v1/proofs/${encodeURIComponent(packetId)}`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    );
  } catch (error) {
    return { ok: false, status: null, message: describeError(error) };
  }
  const body = await readJson(res);
  if (res.status === 200 && isRecord(body)) return { ok: true, proof: body };
  const { error, message } = errorFields(body);
  return { ok: false, status: res.status, message: message || error };
}

export type JwksResult =
  { ok: true; jwks: Jwks } | { ok: false; message: string };

let jwksCache: { url: string; jwks: Jwks; expiresAt: number } | null = null;

/** CounterAudit's export signing keys, cached for an hour. */
export async function fetchJwks(): Promise<JwksResult> {
  const url = `${baseUrl()}/.well-known/counteraudit-export-jwk.json`;
  if (jwksCache && jwksCache.url === url && jwksCache.expiresAt > Date.now()) {
    return { ok: true, jwks: jwksCache.jwks };
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      message: `CounterAudit's export keys could not be fetched: ${describeError(error)}`,
    };
  }
  const body = await readJson(res);
  if (res.status !== 200 || !isRecord(body) || !Array.isArray(body.keys)) {
    return {
      ok: false,
      message: `CounterAudit's export keys could not be read (HTTP ${res.status})`,
    };
  }
  const jwks: Jwks = { keys: body.keys.filter(isRecord) };
  jwksCache = { url, jwks, expiresAt: Date.now() + JWKS_TTL_MS };
  return { ok: true, jwks };
}

export function resetJwksCache(): void {
  jwksCache = null;
}
