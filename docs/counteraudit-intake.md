# CounterAudit intake: operator guide

How the operator seals signed outcome events in CounterAudit and records them in the Bureau. CounterAudit is the system of record; the Bureau keeps one row per sealed event that links to its packet.

## Limits in force

These follow from the Phase 0 decisions (`docs/bureau-outcome-service-phase0.md`) and hold until the owner lifts them.

- **No public endpoint accepts an outcome.** Intake is a script the operator runs by hand. No HTTP or tRPC route reaches it.
- **Test data only.** Every run must carry `--test-data`. A run without it is refused before anything is sent, because outside data waits on the retention decision (decision 5, provisional at 24 months, pending counsel) and on two-person review. Until both exist, the solo-operator path is limited to test data and internal dry runs. Rows are stored with data class `test`.
- **No line is `verified`.** A line shows as `unverified`, or as `withdrawn`, `superseded` or `disputed` once a later signed line from its furnisher says so (`docs/line-states.md`). A passing proof shows that CounterAudit sealed this exact signed event in the Bureau's org and that the furnisher's registered key signed it. It does not show that the outcome happened. The intake also checks each line's evidence against the chain where a check exists (`docs/evidence-verifier.md`) and stores the result, but showing a line as `verified` also needs two-person review, which is not built, so nothing sets it yet.
- **The Bureau holds no private keys.** Furnishers sign with their own keys. The operator registers each furnisher's public key in CounterAudit (`POST /v1/admin/outcome-signers`, which needs CounterAudit's admin TOTP). This code never registers keys.

## Before a run

1. Get a signed JSONL file, one event per line, as `agent-bureau-furnish sign` writes it (outcome event v1).
2. Make sure the signing key is registered for that `furnisher_id` and `key_id` in the Bureau's CounterAudit org. Otherwise CounterAudit refuses each event with `outcome_signer_unknown`.
3. Set the environment (below), in the shell or in `.env`.
4. Make sure the database has the `outcome_events` table with its evidence columns (migration 0008). The server applies migrations when it starts, or run `pnpm db:migrate`. The script checks this before it sends anything, so it cannot seal events it has nowhere to store.

## Environment

| Variable                  | Use                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `COUNTERAUDIT_API_URL`    | CounterAudit's API. Default `https://api.counteraudit.io`.                                    |
| `COUNTERAUDIT_ORG_ID`     | The Bureau's CounterAudit organization. Every proof must name this org, or its check fails.   |
| `COUNTERAUDIT_INGEST_KEY` | An API key of that org with the `ingest` role. Secret: the script never prints it.            |
| `DATABASE_URL`            | The Bureau's MySQL database, as for the server.                                               |
| `ARC_TESTNET_RPC_URL`     | Arc testnet JSON-RPC for the evidence check, read-only. Default `https://rpc.testnet.arc.io`. |

## Run

From a checkout with dependencies installed:

```sh
pnpm furnish:intake --test-data signed.jsonl
```

For each line the script sends the event to `POST /v1/audit/ingest` with the `agent-bureau-outcome-v1` connector and `public_proof: true`, fetches the packet's public proof from `GET /v1/proofs/{packet_id}`, checks it, checks the event's evidence, and stores the line. It prints one line per event and a summary. Exit code 0 means every event was sealed, its proof verified and its line stored; 1 means at least one was not; 2 means the run was refused before anything was sent.

Running the same file again is safe. CounterAudit answers 200 with the packet it already sealed, and the stored line keeps its times, state and data class; only its checks are refreshed. A proof check is recorded when it ran, and an evidence check when it reached a result (not `pending` or an error), so a run during an RPC outage does not overwrite an earlier result.

After storing a line, the intake settles its display state and, if the line carries a `relation`, its target's: `withdraws ... applied, that line is now withdrawn`, `not applied` with the reason, or `no such line yet` when the target has not been stored. `docs/line-states.md` has the rules.

## What each result means

| Result                                    | Meaning                                                                                                                                    | Stored?             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `sealed (201)`                            | CounterAudit sealed the event as a new packet.                                                                                             | Yes                 |
| `already sealed (200)`                    | This exact event was sealed before; its packet comes back.                                                                                 | Yes, if not already |
| `conflict (409 outcome_event_conflict)`   | The furnisher already used this `event_id` for a different event. A correction must be a new event whose `relation` points at the old one. | No                  |
| `refused (422 outcome_schema_invalid)`    | Not a valid furnish v1 event.                                                                                                              | No                  |
| `refused (422 outcome_signer_unknown)`    | The org has no active key for this `furnisher_id` and `key_id`.                                                                            | No                  |
| `refused (422 outcome_signature_invalid)` | The signature does not verify with the registered key.                                                                                     | No                  |
| `did not seal it`                         | Any other answer, or none (bad key, rate limit, network). Nothing is known sealed.                                                         | No                  |
| `not sent`                                | The line is not JSON or lacks the fields the Bureau stores.                                                                                | No                  |

After a seal, the proof is reported as `verified`, `FAILED` with the checks that failed, or `not checked` when the proof or CounterAudit's keys could not be fetched. A sealed event is stored whatever its proof result, with the result recorded, because the packet exists either way. Run the file again to retry a proof that was not checked.

The evidence is then reported as `verified`, `needs review`, `FAILED` or `not final yet` with its reasons, or `not checked` when the chain could not be read. The exit code does not depend on it: most outcomes have no machine check yet and always go to review. See `docs/evidence-verifier.md` for what each result means.

## Proof checks

`server/outcomeProof.ts` runs each check on its own and stores every result:

- `proof_signature`: CounterAudit's eddsa-jcs-2022 signature over the proof verifies with its key from `/.well-known/counteraudit-export-jwk.json`. This is a port of CounterAudit's `verifyExportSignature`.
- `org_id`, `connector_id`, `packet_id`: the proof is for the Bureau's org, the furnish connector and the packet ingest returned.
- `public_proof`, `content_verified`: both true.
- `signed_event_hash`: SHA-256 of the event's RFC 8785 canonical JSON equals the hash CounterAudit sealed.
- `event_signature`: the event's signature verifies with the signer key the proof names.
- `signer_matches_event`: the proof's `furnisher_id`, `key_id` and `event_id` are the event's.

## Three times, kept apart

- `occurredAt`: the furnisher's `occurred_at`, inside the signed event. It is the furnisher's claim and never shown as independently trusted.
- `receivedAt`: when the Bureau read the event.
- `caCreatedAt`: CounterAudit's seal time.

## Not built yet

The `verified` display state and two-person review, subject disputes, furnisher records, assembling files, the unsigned CSV pilot fallback, and any intake of outside data.
