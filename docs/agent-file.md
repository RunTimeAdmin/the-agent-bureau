# An agent's file

What the Bureau holds on one subject, as of one time, as a signed JSON file. This is the first version of file assembly (`docs/bureau-spec.md`, "What a file contains"): it holds the furnished outcomes section and says plainly what it does not hold yet. Code: `server/agentFile.ts`, run as `pnpm file`.

## What is on a file

A line is on a subject's file when its `subject_ref` names exactly that subject (an EVM address in a wallet or a `did:sigvara` compares without case) and reviewers released it (`docs/two-person-review.md`). A line reviewers have not released is held and not shown, whatever its outcome. Phase 0 decision 4 requires that only for negative outcomes; a file applies it to every outcome, so it says only what passed review.

What a line says (its subject, outcome, time and relation) is read from the signed event the reviewers approved, never from the table's copies of those fields, which nothing signs. The event must hash to the `signed_event_hash` reviewers signed and name the row's own furnisher and event id. If any stored line fails that, the store was changed or damaged, and `pnpm file assemble` signs nothing until it is fixed: a withdrawal that stopped acting that way could put a line back on a file.

A released line that a later line from the same furnisher disputes stays in `furnished_outcomes`, shown with the dispute. One the furnisher withdrew or replaced moves to `history`, kept as a record of what was reported (Phase 0 decision 4: "prior line kept in history"), with a disclosure saying it is not a current fact (`docs/line-states.md`).

A line its subject disputed (`docs/disputes.md`) carries the dispute in `dispute`, decided as of the time the file is assembled, and the file then carries a disclosure saying what a subject dispute means. While the dispute is open, or once the furnisher has confirmed the line, it shows as `disputed`; a dispute the furnisher closed by withdrawing or correcting the line stays on it in `history`. A line whose dispute lapsed is `removed`: it is left off the file, `history` included, whatever reviewers decided. Each dispute record is checked again from the record itself when a file is assembled, so a record whose stored check result was edited counts for nothing (`docs/disputes.md`). Apart from its `not_on_file` entry on disputes, a file without a subject dispute is what it was before disputes were built.

Each line carries:

| Field                   | What it is                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outcome`, `data_class` | As the furnisher signed them.                                                                                                                                                                                        |
| `occurred_at`           | The furnisher's claim, never independently checked. `received_at` is when the Bureau read the event and `sealed_at` when CounterAudit sealed it (Phase 0 decision 7).                                                |
| `furnisher_category`    | Not the furnisher's name, which subscribers see only if the furnisher opts in (`bureau-spec.md`). Categories are listed in `FURNISHER_CATEGORIES` by pull request.                                                   |
| `display_state`         | `released`, `disputed`, `withdrawn` or `superseded`.                                                                                                                                                                 |
| `dispute`               | Only on a line its subject disputed: `state` (`open`, `confirmed`, `corrected` or `withdrawn`), `filed_at` (when CounterAudit sealed the dispute), `respond_by` (the furnisher's deadline, while open), `confirmed_at` (when CounterAudit sealed the furnisher's confirmation) and `statement` (the subject's statement beside a confirmed line). |
| `released`              | `two_person`, or `solo_test` for test data one reviewer released.                                                                                                                                                    |
| `review_decisions`      | The review-log decisions on the line, each by its sequence and packet in the review organization, and the decision. |
| `evidence`              | `payment_settlement_verified` or `payment_failure_verified` for a payment the chain proved, `verified` for other machine-checked evidence, or `waived_by_reviewers`.                                                 |
| `payment`               | For `paid`, `refunded` and `payment_failed`: `subject_control` (always `unproven` until Phase 3) and `payer_independence_screen` (`clear`, `flagged` or `inconclusive`, never clear when the screen did not finish). |
| `counteraudit`          | The packet that sealed the event: its id, organization, sequence, entry hash, the SHA-256 of the signed event, the URL of its public proof, and `checkable_until`, the date CounterAudit erases it under its retention policy (`null` when it set none). |

A file also says where the independent review log stood when it was assembled: `review_log` names the review organization and its newest packet (sequence, entry hash and packet id), or is `null` for an empty log. `pnpm file assemble` reads the log to CounterAudit's head itself just before it decides any release, and signs nothing if it cannot read the whole log: a packet it cannot verify, a gap, or fewer stored packets than CounterAudit lists. So a rejection sealed since the last `pnpm review sync` holds its line on the next file (review finding M-01, 1 November 2026). Files assembled before then have neither `review_log` nor `review_decisions`.

## When a line's source expires

A line can be checked for as long as CounterAudit keeps the packet that sealed it, and no longer: a file keeps nothing of erased content, not even a proof of it (decision of 1 November 2026). The Bureau's organization erases its packets 24 months after receipt, and a listed furnisher's organization must do so within 24 months of the seal (`docs/cross-org-intake.md`). So just before signing, `pnpm file assemble` reads each line's public proof, checks it against the line as `pnpm file verify` will, and copies the proof's `expires_at` into the line as `checkable_until`. A line whose source CounterAudit has already erased, or which is past that date, is left off the file, and assemble names it; when that leaves the file with no line, assemble says how many were left off, rather than suggesting the subject is misspelled. A proof it cannot read, or one that does not check, stops the file: none is signed that its own verify would fail. A file with a dated line carries a disclosure saying what happens at that date. Files assembled before 1 November 2026 have no `checkable_until`.

After the date, the proof URL answers 410 with CounterAudit's signed record of the erasure (`counteraudit.packet_tombstone`). It still shows the packet sat at that sequence and entry hash in that organization's chain, and when it was erased, but no longer the outcome or the event's hash. `pnpm file verify` checks that record against CounterAudit's export key and the line, and reports the line as expired, not failed: from then on the line rests on the Bureau's signature alone. A record of erasure that does not check is a failure. Verify also says when CounterAudit erased the source before the file's `checkable_until`.

The Bureau erases its own copy too. `pnpm lines expire` reads every stored line's public proof the same way and, for a line whose source CounterAudit has erased (its signed record checks) or whose `expires_at` has passed, erases what the row says about the subject: the signed event, the subject reference, the evidence result, the settlement claim (it names an on-chain transfer, and so the payer) and CounterAudit's receipt. It sets `expiredAt` and shows the line as `unverified`. It erases the same from the subject's dispute records on the line (`docs/disputes.md`): the record itself, CounterAudit's receipt, the agent address read for a `did:sigvara` and the text of why a check failed, which names wallets. Each keeps its ids, kind, packet, sequence, seal time and what its checks found, and counts for nothing from then. The row keeps the furnisher and event ids, the hashes, the packet id, the outcome and the times, so the same event cannot be stored again as a new line and the review log's decisions still have their line; an expired line is on no file and out of the review queue, and the intake writes nothing back into it. It trusts a proof's `expires_at` only when the proof is CounterAudit's for that packet (signature, organization, sequence and entry hash), whether or not the rest still checks. A line it cannot check is left alone and named, and the run exits 1.

A line whose relation still acts on a line that stands (a withdrawal, a replacement or a dispute) is held, not erased, since erasing it would put a withdrawn line back or take a dispute off: it is erased with its target, which a line sealed earlier normally reaches first. A held line also makes the run exit 1, because it outlives its source. `--dry-run` reports without erasing.

The settlement claim was what kept one charge from backing two lines. With it erased, the evidence check refuses any charge older than the 24-month retention baseline instead (`docs/evidence-verifier.md`). That covers a line in the Bureau's organization, whose source expires 24 months after the Bureau received it, give or take the day the event may precede its charge. A furnisher's organization with a shorter policy frees the charge sooner, for the rest of the 24 months.

```bash
pnpm lines expire --dry-run
pnpm lines expire
```

It needs `DATABASE_URL` and `COUNTERAUDIT_ORG_ID`, and the database must have migration `0013_line_expiry`, which the app applies when it starts. It is not scheduled yet.

Tested end to end: `scripts/e2e/file-expiry.ts` runs this path against a CounterAudit server started from a checkout, from the furnisher's seal to `pnpm lines expire` and a file without the line ([docs/e2e-file-expiry.md](e2e-file-expiry.md)).

## The state names (review finding M-04)

A line reviewers released shows as `released`. Phase 0 named that state `verified`; it was renamed before any file existed, because a release records what the checks and the reviewers found, not that the outcome happened. Migration 0012 renamed it on stored lines. Payment evidence uses the names decided in `docs/independent-payer.md`, and every file carries its disclosure:

> A settled payment proves that money moved between two wallets, not who controls them or whether the service was delivered.

Every file also says it is not a score, a grade or a recommendation. A file with a `solo_test` line says what that means, and a file of test data only says so. `reviewers` is `operator_held_testnet` while the review log's genesis is the testnet one (`docs/review-log-design.md`), and the file then says that `two_person` there does not mean two independent people.

## Third-party standing

For a subject that is a Sigvara agent (`{"did":"did:sigvara:5042002:<agent address>"}`), the file carries Sigvara's standing in `third_party_standing`, labelled as a fact Sigvara computes and not the Bureau's verdict (`bureau-spec.md`: "Sigvara's score appears as a labeled third-party fact"). It is read from Sigvara's contracts on Arc testnet at one finalized block, and the file names the block's number, hash and time:

- `status`: `Active`, `Suspended`, `Slashed` or `PendingBond` from SigvaraIdentity, or `not_registered`;
- `score`: `total` is SigvaraReputation's `getTotalScore` at that block, the matured score, which can trail the factors after a rise and restarts after an operator handover, so it can be below their sum; the factors are the last finalized proposal's, with when it was finalized;
- `stake` and `has_minimum_stake` from SigvaraStaking.

The contract addresses are pinned in `server/sigvaraStanding.ts` from Sigvara's `deployments/5042002.json`, by pull request, so a file says what those contracts said rather than whatever an RPC setting points at. The agent's `didHash` is `keccak256(abi.encodePacked("did:sigvara:", chainid, ":", agentAddress))`, as SigvaraIdentity computes it. If the subject is a Sigvara agent and the chain cannot be read, nothing is signed. Any other subject has no standing, and the file says so. The score is Sigvara's finalized one: an outcome Sigvara has recorded counts only once its next score proposal has finalized on chain.

## Not on file yet

Each file lists what it cannot show, in `not_on_file`: lines for other registrations, wallets or DIDs of the same operator (subject matching is Phase 3), held lines, public record and payment history, third-party standing other than Sigvara's, and inquiries. It also says that a subject disputes a line through the Bureau's operator, and that a page where subjects file disputes themselves is not built. A line with a dispute carries it in `dispute`.

Matching is exact apart from EVM addresses in a wallet or a `did:sigvara`, so a subject spelled another way (an address in a DID or registry id in other case, say) gets a file with no lines. `--subject` must be one of the outcome event v1 `subject_ref` forms, and `pnpm file assemble` warns when no line matches.

## Signing and checking

The Bureau signs each file with an Ed25519 key over `agent-bureau/file/v1\n` followed by the RFC 8785 canonical file without its `signature`. The keys are pinned in `server/bureauFileKeys.ts` by pull request and served at `/.well-known/agent-bureau-file-keys.json`, and `pnpm file assemble` refuses to sign with a key that is not the one pinned under its key id.

A reader of a file checks these, which `pnpm file verify <file>` does:

1. **The Bureau's signature**, against a pinned key, so the file came from the Bureau unchanged. A file in which a key appears twice in one object is refused, since another JSON parser could read it differently.
2. **Who and when.** Verify prints the subject, the file id, when it was issued and who the reviewers were. A valid file can still be another agent's, or an old one from before a line was released, so `--subject` checks the subject and `--max-age-days` the age.
3. **Each line against CounterAudit's public proof** (`GET /v1/proofs/{packet_id}`, no key needed), checked against CounterAudit's pinned export key: CounterAudit sealed a packet with that id in that organization, at that sequence and entry hash and that time, holding an event with that hash and that outcome, and checked the furnisher's signature on it when it sealed it. In an organization a furnisher listed in `server/furnishers.ts` runs, the proof's signer must also be a key listed for that furnisher, since there the furnisher registered its keys itself. Once CounterAudit has erased the packet, verify checks its signed record of the erasure instead and reports the line as expired ([When a line's source expires](#when-a-lines-source-expires)).

4. **Sigvara's standing against the chain.** Each fact is read again at the block the file names, from the same contracts, and the entry must be exactly what that reads, wording and fields included: the block hash, status, score, factors and stake. The block must be finalized and read within 15 minutes before the file was issued, so a file cannot show a standing from before a slash. Verify trusts the RPC it reads (`ARC_TESTNET_RPC_URL`, by default the same public RPC that assembled the file); a reader who wants a check independent of that RPC points it at a node of their own. Arc testnet's public RPC serves past blocks, so an old file can still be checked.
5. **The review log, with the review organization's read key.** Verify prints the position the file states. With `COUNTERAUDIT_REVIEW_ORG_ID` and `COUNTERAUDIT_REVIEW_READ_KEY` set, it reads that packet and each decision a line names from the review organization, and checks that they sit where the file says and hold that decision on that line's event. Review packets are not public (`docs/review-log-design.md`), so without the key verify says this was not checked.

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

`COUNTERAUDIT_ORG_ID` (the Bureau's organization) must be set too, and for assemble `COUNTERAUDIT_REVIEW_ORG_ID` and `COUNTERAUDIT_REVIEW_READ_KEY`, the review organization and the Bureau's read key to it, as for `pnpm review sync`. `pnpm file verify file.json --subject '{"did":"did:example:123"}' --max-age-days 7` also checks the subject and age, and `--offline` skips the proofs and the chain. `ARC_TESTNET_RPC_URL` (default `https://rpc.testnet.arc.io`) is where Sigvara's contracts are read, for both commands. While the review log holds only the operator-held testnet reviewers (`docs/review-log-design.md`), only test-data lines can be released, so only test-data lines can be on a file.

`pnpm file subject --subject '{"wallet":"0x..."}' --out view.json` writes the subject's view (`docs/disputes.md`): every line ever released on the subject, with the furnisher, the signed event and the rest a file leaves out. It needs the same settings as assemble, but no file key: the view is not signed.

A key has no validity window: a key kept in `server/bureauFileKeys.ts` so old files still verify could sign a new file dated in the past. When a key is retired, destroy its private key. The site serves only pinned keys that parse, with a five-minute cache and open CORS so a subscriber's page can read them.

## Not built yet

- Serving files to subscribers: an API or MCP tool, pricing, and an inquiry logged for each pull, visible to the subject (`bureau-spec.md`, Subscribers).
- The other sections of a file listed under `not_on_file`.
