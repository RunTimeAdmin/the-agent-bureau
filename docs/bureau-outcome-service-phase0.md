# The Agent Bureau: Phase 0 decisions

Lock the product, data and trust decisions before any public endpoint accepts an outcome from outside.

```
Owner:      David (RunTimeAdmin)
Status:     Decisions recorded 2026-10-29. Two items await external input: retention (counsel) and CounterAudit envelope sealing (CounterAudit team).
Created:    2026-10-29
Decided:    2026-10-29
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

- Decision: **Accept the full set above.** Each outcome carries an evidence tier and shows as `verified` only after its evidence check passes; a nonempty evidence reference alone is not verified. `paid`, `refunded` and `delivered` are backed by on-chain settlement or a trusted provider log; `payment_failed`, `not_delivered`, `access_revoked` and `policy_violation` rely on furnisher signed logs or a CounterAudit packet plus human review until a dedicated verifier exists (see item 3 below).

### 2. Initial chain scope

Proposed: ship one chain adapter first, the one with a verified registry/token map, read-only RPC controls and a written finality/reorg policy. Every other chain is "unsupported" or "unverified" until its verifier exists. (Open question §15.2: which first evidence path, on-chain settlement, furnisher signed logs, or a CounterAudit packet.)

- Decision: **Arc first, on-chain settlement via Levy.** Launch one chain adapter, Arc, where Sigvara and Levy already run. The first evidence path is on-chain settlement read from Levy's USDC billing, which records paid and failed charges on-chain (resolves §15.2). Arc gets the verified registry/token map, read-only RPC controls and a written finality/reorg policy; every other chain stays unsupported until its own verifier is ready.

### 3. Subject scope and matching

Proposed: define how a registry ID, a wallet and a DID each map to one subject, and what proof confirms control. Uncertain matches are stored separately and never merged into a file silently. (Open question §15.4: one key per business, several scoped keys, or an enterprise signer; the Bureau custodies none.)

- Decision: **Several scoped keys per furnisher, each tagged with `key_id`.** A furnisher may run keys per system and rotate them without losing attribution, matching the v1 `key_id` design (resolves §15.4). The Bureau custodies no private keys. How registry IDs, wallets and DIDs map to a subject, and what proof confirms control, is written in Phase 3; uncertain matches are stored separately and never merged silently.

### 4. Publication rule

Proposed: a negative outcome is never displayed as established fact until its signature, source packet, evidence policy and any required review all pass. A subject dispute changes the displayed status immediately and stays in the file history. Proposed file-display states:

- `unverified` (received, signature valid, evidence not yet checked)
- `verified` (evidence policy for that outcome passed)
- `disputed` (subject contested; shown with the dispute, not hidden)
- `withdrawn` / `superseded` (a later event in the same scope replaced it; prior line kept in history)

- Decision: **Accept as drafted.** The four display states stand, and so does the rule: no negative line is shown as established fact until signature, source packet, evidence policy and any required review pass, and a subject dispute flips the status immediately and stays in the file history.

### 5. Data policy

Proposed: approve purpose limitation, subject access, correction and dispute, retention, deletion, backup expiry and access logging. The spec proposes 24-month file retention while CounterAudit keeps the sealed audit history. (Open question §15.5: retention for source envelopes, derived indexes, disputes, backups and operator access logs.) Confirm with counsel before accepting any personal or commercially sensitive data.

- Decision: **24-month file retention, provisional pending counsel.** CounterAudit keeps the sealed audit history. Purpose limitation, subject access, correction and dispute, deletion, backup expiry and access logging are approved in principle. Counsel must sign off the retention number and these policies before any personal or commercially sensitive data is accepted (resolves §15.5, subject to counsel).

### 6. CounterAudit authorization

Proposed: provision a dedicated Bureau organization in CounterAudit. Decide whether CounterAudit adds per-key scopes, and how a furnisher's evidence packet from its own CounterAudit organization is verified without exposing that organization's API key. (Open question §15.1: does CounterAudit seal the full source envelope and offer cross-org proof, or does the Bureau store a separately encrypted envelope with a CounterAudit commitment? The second option changes the spec's claim that CounterAudit alone is the record store.)

- Decision: **CounterAudit seals the full envelope and issues a cross-org proof.** This keeps the spec's position that CounterAudit is the record store. It depends on the CounterAudit team adding full signed-envelope sealing and a shareable packet proof a third party can validate without the furnisher's API key, in a dedicated least-privilege Bureau organization (resolves §15.1; blocked on CounterAudit delivery). Intake does not go live until that lands.

### 7. Receipt semantics

Proposed: keep three timestamps distinct and never present the furnisher's as independently trusted:

- `occurred_at` (furnisher-supplied, inside the signed event)
- `received_at` (Bureau, outside the signed event)
- `created_at` (CounterAudit seal time)

- Decision: **Accept as drafted.** `occurred_at` (furnisher-supplied, inside the signed event), `received_at` (Bureau, outside it) and `created_at` (CounterAudit seal time) stay distinct, and the furnisher's timestamp is never presented as independently trusted.

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

From §15 of the plan. Status as of 2026-10-29:

1. **Resolved, pending CounterAudit delivery.** CounterAudit seals the full source envelope and provides cross-org proof (decision 6). Blocked on the CounterAudit team building it; no intake before then.
2. **Resolved.** First evidence source is on-chain settlement on Arc, read via Levy (decision 2).
3. **Direction set, fields are Phase 2.** `payment_failed` and `not_delivered`, where there may be no successful on-chain receipt, are evidenced by furnisher signed logs or a CounterAudit packet plus human review, and never show as `verified` without a passing check. The exact evidence field shapes are drafted in Phase 2.
4. **Resolved.** Several scoped keys per furnisher, each with a `key_id`; the Bureau custodies none (decision 3).
5. **Pending counsel.** 24-month retention is provisional; counsel must confirm retention for source envelopes, derived indexes, disputes, backups and operator access logs before external data is accepted (decision 5).
6. **Resolved.** Two-person review is required before any approval, match change, evidence waiver or negative-line release affects a third party. The solo-operator path is limited to test data and internal dry runs.

## Exit criteria

Owner sign-off recorded 2026-10-29 on the v1 outcome scope, the publication rule and file-display states, the furnisher key and identity-matching model, and the receipt semantics. Two items stay open before any public endpoint accepts an external outcome:

- **Retention and data policy**: provisional at 24 months, awaiting counsel sign-off.
- **CounterAudit extension**: full envelope sealing and cross-org proof, awaiting the CounterAudit team.

No public endpoint accepts an external outcome until both close.
