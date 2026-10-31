# The Agent Bureau: Phase 0 decisions

Lock the product, data and trust decisions before any public endpoint accepts an outcome from outside.

```
Owner:      David (RunTimeAdmin)
Status:     Draft for owner approval
Created:    2026-10-29
Relates to: docs/bureau-spec.md, the Outcome Ingestion and Evidence Verification Implementation Plan (Phase 0, §4 and §15)
```

## Objective

Turn the ideas the spec already states (CounterAudit is the system of record, negative lines need evidence, subjects can dispute, furnishers are vetted, the Bureau computes no score) into testable rules the owner has signed off. Until every decision below is approved, no public endpoint accepts an external outcome, and no negative line is shown as established fact.

## What this groundwork already settled in code

Three no-dependency pieces are in review now. None accepts external data; each only prepares the decisions this doc asks for.

- **Draft `outcome-event-v1`** in `agent-bureau-furnish`, kept beside v0 and not yet accepted. It adds `key_id` (which signing key produced the signature, so a furnisher can rotate keys) and an optional `relation` to an earlier event with an explicit type (`disputes`, `corrects`, `supersedes`, `withdraws`). It signs over a distinct `agent-bureau/outcome-event/v1\n` domain prefix, so a v0 signature can never be replayed as v1 or the reverse. The schema is published to `schema/outcome-event-v1.json`.
- **Readiness that checks the schema**, not just the connection. `/api/ready` now returns not-ready when the Bureau tables are missing, so a boot migration that failed (the server keeps serving) is kept out of rotation.
- **This decision doc.**

Approving the decisions below is what lets the next phases (CounterAudit envelope sealing, storage, intake) begin.

## Decisions to record

Each decision has a proposed default drawn from the spec. The owner confirms or edits the decision line.

### 1. Initial accepted event scope

Proposed: accept the six outcomes v0 already defines (`paid`, `refunded`, `delivered`, `payment_failed`, `not_delivered`, `access_revoked`, `policy_violation`), and for each, state whether it is backed by on-chain evidence, a trusted provider log, or human review. A nonempty evidence reference is not, by itself, "verified."

- Decision: ________________________________________________

### 2. Initial chain scope

Proposed: ship one chain adapter first, the one with a verified registry/token map, read-only RPC controls and a written finality/reorg policy. Every other chain is "unsupported" or "unverified" until its verifier exists. (Open question §15.2: which first evidence path, on-chain settlement, furnisher signed logs, or a CounterAudit packet.)

- Decision: ________________________________________________

### 3. Subject scope and matching

Proposed: define how a registry ID, a wallet and a DID each map to one subject, and what proof confirms control. Uncertain matches are stored separately and never merged into a file silently. (Open question §15.4: one key per business, several scoped keys, or an enterprise signer; the Bureau custodies none.)

- Decision: ________________________________________________

### 4. Publication rule

Proposed: a negative outcome is never displayed as established fact until its signature, source packet, evidence policy and any required review all pass. A subject dispute changes the displayed status immediately and stays in the file history. Proposed file-display states:

- `unverified` (received, signature valid, evidence not yet checked)
- `verified` (evidence policy for that outcome passed)
- `disputed` (subject contested; shown with the dispute, not hidden)
- `withdrawn` / `superseded` (a later event in the same scope replaced it; prior line kept in history)

- Decision: ________________________________________________

### 5. Data policy

Proposed: approve purpose limitation, subject access, correction and dispute, retention, deletion, backup expiry and access logging. The spec proposes 24-month file retention while CounterAudit keeps the sealed audit history. (Open question §15.5: retention for source envelopes, derived indexes, disputes, backups and operator access logs.) Confirm with counsel before accepting any personal or commercially sensitive data.

- Decision: **provisional baseline, recorded 2026-10-31 by the owner.** Counsel checks the Bureau's legal obligations before launch, and no outside outcome is accepted before then.
  - No law sets a single retention period for this data. Each data category gets its own period, with a stated reason, and data is deleted or anonymized once it is no longer needed. Correction and erasure requests are honoured.
  - **Active file: at most 24 months** from the Bureau's `received_at`. After that the outcome and its source content are removed from files, APIs and indexes. 24 months is a chosen product policy, not a legal safe harbor.
  - **Backups** expire on a rolling 90 days.
  - **Security logs** are kept 12 months and carry no payloads.
  - **Legal hold** applies only to a specific case, with a reason and a review date.
  - **CounterAudit** does not keep identifiable source content indefinitely by default: it expires or crypto-erases it after 24 months, and keeps a minimal commitment only if counsel confirms that is appropriate. Today CounterAudit keeps every sealed packet with no expiry, so this is a requirement CounterAudit must meet before outside outcomes are sealed.
  - **Sigvara's** public outcome sharing and peer import stay off on mainnet until this policy covers copies held by other operators, because those copies cannot be guaranteed deleted.

### 6. CounterAudit authorization

Proposed: provision a dedicated Bureau organization in CounterAudit. Decide whether CounterAudit adds per-key scopes, and how a furnisher's evidence packet from its own CounterAudit organization is verified without exposing that organization's API key. (Open question §15.1: does CounterAudit seal the full source envelope and offer cross-org proof, or does the Bureau store a separately encrypted envelope with a CounterAudit commitment? The second option changes the spec's claim that CounterAudit alone is the record store.)

- Decision: ________________________________________________

### 7. Receipt semantics

Proposed: keep three timestamps distinct and never present the furnisher's as independently trusted:

- `occurred_at` (furnisher-supplied, inside the signed event)
- `received_at` (Bureau, outside the signed event)
- `created_at` (CounterAudit seal time)

- Decision: ________________________________________________

## v1 schema: testable rules now drafted

These are implemented in the v1 draft and are what the owner is approving as the shape of a v1 event. They do not go live until Phase 2.

- `schema_version` is the literal `"1"`. Unknown fields are rejected (strict objects).
- Required: `furnisher_id` (`fur_…`), `key_id`, unique `event_id`, `subject_ref`, `occurred_at` (UTC, RFC 3339), `outcome`.
- `amount` is required for payment outcomes; evidence with at least one pointer is required for `payment_failed`, `not_delivered`, `access_revoked` and `policy_violation`. (Same rules as v0.)
- `relation` is optional. When present it carries a `type` (`disputes` | `corrects` | `supersedes` | `withdraws`) and a `target_event_id`. The tool rejects a relation that points at the event's own id.
- Signature is Ed25519 over `agent-bureau/outcome-event/v1\n` followed by the RFC 8785 canonical JSON of the event without its signature. `key_id` and every semantically relevant field are inside the signed payload. `received_at` is not.

Left to the receiver by design, because each needs the whole event history or external state, not a single file:

- That a `relation` target exists, is in the same furnisher/subject scope, and forms no cycle.
- Evidence verification itself (on-chain lookup, packet retrieval, provider-log checks).
- Duplicate `event_id` across batches and furnishers (the tool already rejects duplicates within one file).

Open from the plan and not yet drafted: evidence field shapes specific enough to verify (chain/network, tx hash, log index, contract/token for on-chain; packet ID or content-addressed artifact for off-chain), strict length and enumeration bounds, and an optional signed batch manifest. These are Phase 2 work, decided after the scope choices above.

## Items to resolve before implementation starts

From §15 of the plan. These block the phases that touch external data, not this groundwork.

1. CounterAudit sealed source-envelope and cross-org proof, or a Bureau-stored encrypted envelope with a CounterAudit commitment (see decision 6).
2. The first practical evidence source: on-chain settlement, furnisher signed logs, or a CounterAudit packet (see decision 2).
3. The exact source evidence for `payment_failed` and `not_delivered`, where there may be no successful on-chain receipt.
4. The furnisher key model: one key per business, several scoped keys, or an enterprise signer; the Bureau custodies none (see decision 3).
5. Retention for source envelopes, derived indexes, disputes, backups and operator access logs; confirm with counsel (see decision 5).
6. Who may approve a furnisher, alter a match, waive an evidence rule or release a negative line. The one-person operator model needs a two-person review plan before any of this affects a third party.

## Exit criteria

Sign-off from the product owner on: the v1 outcome scope, the evidence policy, the retention policy, the identity-matching policy, the file-display states, and the CounterAudit extension. No public endpoint accepts an external outcome before these decisions exist.
