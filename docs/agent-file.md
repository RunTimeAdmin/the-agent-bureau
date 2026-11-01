# An agent's file

What the Bureau holds on one subject, as of one time, as a signed JSON file. This is the first version of file assembly (`docs/bureau-spec.md`, "What a file contains"): it holds the furnished outcomes section and says plainly what it does not hold yet. Code: `server/agentFile.ts`, run as `pnpm file`.

## What is on a file

A line is on a subject's file when its `subject_ref` names exactly that subject (EVM wallets compare without case) and reviewers released it (`docs/two-person-review.md`). A line reviewers have not released is held and not shown, whatever its outcome. Phase 0 decision 4 requires that only for negative outcomes; a file applies it to every outcome, so it says only what passed review.

What a line says (its subject, outcome, time and relation) is read from the signed event the reviewers approved, never from the table's copies of those fields, which nothing signs. The event must hash to the `signed_event_hash` reviewers signed and name the row's own furnisher and event id. If any stored line fails that, the store was changed or damaged, and `pnpm file assemble` signs nothing until it is fixed: a withdrawal that stopped acting that way could put a line back on a file.

A released line that a later line from the same furnisher disputes stays in `furnished_outcomes`, shown with the dispute. One the furnisher withdrew or replaced moves to `history`, kept as a record of what was reported (Phase 0 decision 4: "prior line kept in history"), with a disclosure saying it is not a current fact (`docs/line-states.md`). Each line carries:

| Field                   | What it is                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outcome`, `data_class` | As the furnisher signed them.                                                                                                                                                                                        |
| `occurred_at`           | The furnisher's claim, never independently checked. `received_at` is when the Bureau read the event and `sealed_at` when CounterAudit sealed it (Phase 0 decision 7).                                                |
| `furnisher_category`    | Not the furnisher's name, which subscribers see only if the furnisher opts in (`bureau-spec.md`). Categories are listed in `FURNISHER_CATEGORIES` by pull request.                                                   |
| `display_state`         | `released`, `disputed`, `withdrawn` or `superseded`.                                                                                                                                                                 |
| `released`              | `two_person`, or `solo_test` for test data one reviewer released.                                                                                                                                                    |
| `evidence`              | `payment_settlement_verified` or `payment_failure_verified` for a payment the chain proved, `verified` for other machine-checked evidence, or `waived_by_reviewers`.                                                 |
| `payment`               | For `paid`, `refunded` and `payment_failed`: `subject_control` (always `unproven` until Phase 3) and `payer_independence_screen` (`clear`, `flagged` or `inconclusive`, never clear when the screen did not finish). |
| `counteraudit`          | The packet that sealed the event: its id, organization, sequence, entry hash, the SHA-256 of the signed event, and the URL of its public proof.                                                                      |

## The state names (review finding M-04)

A line reviewers released shows as `released`. Phase 0 named that state `verified`; it was renamed before any file existed, because a release records what the checks and the reviewers found, not that the outcome happened. Migration 0012 renamed it on stored lines. Payment evidence uses the names decided in `docs/independent-payer.md`, and every file carries its disclosure:

> A settled payment proves that money moved between two wallets, not who controls them or whether the service was delivered.

Every file also says it is not a score, a grade or a recommendation. A file with a `solo_test` line says what that means, and a file of test data only says so. `reviewers` is `operator_held_testnet` while the review log's genesis is the testnet one (`docs/review-log-design.md`), and the file then says that `two_person` there does not mean two independent people.

## Not on file yet

Each file lists what it cannot show, in `not_on_file`: lines for other registrations, wallets or DIDs of the same operator (subject matching is Phase 3), held lines, public record, payment history and third-party standing such as Sigvara's score, and the subject's disputes, statements and inquiries.

Matching is exact apart from EVM wallets, so a subject spelled another way (an address in a DID or registry id in other case, say) gets a file with no lines. `--subject` must be one of the outcome event v1 `subject_ref` forms, and `pnpm file assemble` warns when no line matches.

## Signing and checking

The Bureau signs each file with an Ed25519 key over `agent-bureau/file/v1\n` followed by the RFC 8785 canonical file without its `signature`. The keys are pinned in `server/bureauFileKeys.ts` by pull request and served at `/.well-known/agent-bureau-file-keys.json`, and `pnpm file assemble` refuses to sign with a key that is not the one pinned under its key id.

A reader of a file checks these, which `pnpm file verify <file>` does:

1. **The Bureau's signature**, against a pinned key, so the file came from the Bureau unchanged. A file in which a key appears twice in one object is refused, since another JSON parser could read it differently.
2. **Who and when.** Verify prints the subject, the file id, when it was issued and who the reviewers were. A valid file can still be another agent's, or an old one from before a line was released, so `--subject` checks the subject and `--max-age-days` the age.
3. **Each line against CounterAudit's public proof** (`GET /v1/proofs/{packet_id}`, no key needed), checked against CounterAudit's pinned export key: CounterAudit sealed a packet with that id in that organization, at that sequence and entry hash and that time, holding an event with that hash and that outcome, and checked the furnisher's signature on it when it sealed it. In an organization a furnisher listed in `server/furnishers.ts` runs, the proof's signer must also be a key listed for that furnisher, since there the furnisher registered its keys itself.

A pass on a line says nothing about its subject, data class or release, which only the Bureau's signature vouches for. A file leaves out the signed event, which names the furnisher and holds the evidence, so a subscriber cannot check the furnisher's signature or the binding to the subject alone; for those it relies on the Bureau's signature and on CounterAudit's check at seal time. The subject and the reviewers get the signed events and can run the full proof check (`server/outcomeProof.ts`).

The public proof behind `proof_url` shows more than the file does: the furnisher's id (`fur_...`), key id and key, and the furnisher's own `event_id`. These are pseudonymous (`server/furnishers.ts` lists organizations and keys, not business names), but they link one furnisher's lines across files, and for a furnisher sealing in its own organization the `org_id` alone does.

## Running it

Where the file key lives, once:

```
pnpm file keygen <private-key-file>
```

List the public key it prints in `server/bureauFileKeys.ts` under a new key id, by pull request. Then, with `DATABASE_URL` set:

```
pnpm file assemble --subject '{"did":"did:example:123"}' --key <private-key-file> --key-id <key id> --out file.json
pnpm file verify file.json
```

`COUNTERAUDIT_ORG_ID` (the Bureau's organization) must be set too. `pnpm file verify file.json --subject '{"did":"did:example:123"}' --max-age-days 7` also checks the subject and age, and `--offline` skips the proofs. While the review log holds only the operator-held testnet reviewers (`docs/review-log-design.md`), only test-data lines can be released, so only test-data lines can be on a file.

A key has no validity window: a key kept in `server/bureauFileKeys.ts` so old files still verify could sign a new file dated in the past. When a key is retired, destroy its private key. The site serves only pinned keys that parse, with a five-minute cache and open CORS so a subscriber's page can read them.

## Not built yet

- Serving files to subscribers: an API or MCP tool, pricing, and an inquiry logged for each pull, visible to the subject (`bureau-spec.md`, Subscribers).
- The subject's view, which names furnishers and includes the signed events.
- The other sections of a file listed under `not_on_file`.
