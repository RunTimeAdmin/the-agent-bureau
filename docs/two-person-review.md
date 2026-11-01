# Two-person review

No line shows as `released` until reviewers release it (Phase 0 item 6). Each reviewer signs their decisions with their own key on their own machine and seals them in the independent review log, a CounterAudit organization they write to with their own key (`docs/review-log-design.md`). The operator never handles a decision. The Bureau reads the log and counts only what is sealed there, checking every signature each time a line is settled. Code: `server/reviewDecision.ts` (decisions), `server/reviewLog.ts` (reviewer-key records and the log's rules), `server/reviewLogSync.ts` (reading and sealing), `server/lineState.ts` (`releaseFor`), `server/settleLines.ts` (`loadReviewLog`, `reviewsFor`) and `server/review.ts` (`pnpm review`).

## Release rule

A line is released, and shows as `released`, when all of these hold:

1. **Its proof passed**: CounterAudit sealed it and the furnisher's signature checked out (`source_signed`).
2. **Its evidence allows it.**
   - `verified` evidence: any approval counts, except for a settled payment whose funding screen (`docs/evidence-verifier.md`) is not `clear`: a flag, an inconclusive screen or none needs an approval that waives it, with a reason.
   - `needs_review` evidence, which a person must judge (no machine check applies, or the check found something only a person can settle, such as a subject that is not a wallet or a merchant paying itself): only an approval that waives it (`approve_with_waiver`, with a reason) counts.
   - `failed` evidence can never be waived. `pending`, `error` or no check yet: run the intake again first.
3. **It holds the claim on its charge**, if it is backed by one (`docs/evidence-verifier.md`), so no two released lines rest on one charge.
4. **No reviewer currently rejects it, and none who decided on it is suspended.**
5. **Enough approvals from different reviewers**: two for live data, one for test data (Phase 0 item 6 keeps the solo path for test data and dry runs). `pnpm review queue` reports a solo release as such, and a file must label it.

**Approving a payment line.** `pnpm review queue` names what a payment line's evidence proved: `payment_settlement_verified` for a `paid` or `refunded` line whose evidence is `verified`, `payment_failure_verified` for `payment_failed`. Beside it are `subject_control` and `payer_independence_screen` (`docs/independent-payer.md`), and the reminder that a settled payment proves that money moved between two wallets, not who controls them or whether the service was delivered. Approving a payment line confirms you judged whether the payer is related to the furnisher, and you may reject on relatedness alone. The queue lists the funding screen's flags and gaps. Subject control is Phase 3, so it reads `unproven` until then.

Each decision is signed for one line (`furnisher_id`, `event_id`), one version of its event (`signed_event_hash`), its data class, and the digest of its evidence result as the reviewer saw it (`evidence_digest`). A decision for another version or data class never counts. An approval counts only while the line's evidence result still has that digest: if a re-run of the intake changes it (a reused charge found, say), the approval stops counting and the line needs a new review. A rejection holds the line whatever evidence it was signed against.

Each reviewer's latest decision counts, ordered by the time they signed it, not the order it was sealed. A reviewer changes their mind by signing and sealing a new decision.

A dispute, withdrawal or replacement (`docs/line-states.md`) outranks a release: a disputed line shows as `disputed` at once, whatever reviewers decided.

## What is trusted

Only records sealed in the review log count. `pnpm review sync` stores each packet it reads in `review_log_records` (migration 0011), and every settle replays the stored log by its rules, checking each record's signature against the reviewer set the log itself establishes. So an edited or forged row does not count, a removed reviewer's decisions stop counting, and so does every decision signed with a key since rotated. Only the run of packets linked from sequence 0 is read: a packet deleted from the stored copy stops the count there, and the next sync reads it again. A `displayState` written straight into the database is put back on the next settle.

The stored copy is still the operator's. They can stop syncing, drop the newest packets, or blank a stored record, which keeps the chain linked. So each reviewer keeps the receipt of every record they seal, and checks that `pnpm review queue` lists it at that sequence. The queue prints the sequence the Bureau has read to, and each decision it counts on a line with its packet, for comparing with what the reviewer sees with their own read key. It also prints where that copy stands against CounterAudit as of the last `pnpm review sync`, which records each run (`review_log_sync`, migration 0014): when it last ran, the last run that read the whole log, how many packets CounterAudit listed (its head) and how many are held here, and why the last run stopped. It flags `STOPPED` (a gap or another problem; nothing past it counts), `BEHIND` (CounterAudit listed packets not read here) and `STALE` (no run read the whole log in 24 hours). File assembly reads the log to its head itself, so these describe the operator's view, not what a file is signed against.

## Reviewers

The review log says who the reviewers are (`docs/review-log-design.md`, Rules). The first reviewers are named in a genesis record that each of them signs, and that the Bureau's code pins. After that, adding a reviewer, rotating a key, re-enabling a suspended reviewer or removing one takes the same change signed by two reviewers. Any one reviewer can suspend another at once: a line on which the suspended reviewer holds a current decision is held until the reviewers re-enable, rotate or remove them. A suspended reviewer still votes, so no one key can lock the others out. Ids are `rev_` and 3 to 32 lowercase letters or digits; no two reviewers share a key. Until a genesis has taken effect, nothing can be released.

**Testnet (2026-10-31).** The pinned genesis is a testnet one: three reviewers the operator holds (`rev_testnet1` to `rev_testnet3`, named "Testnet reviewer N (operator-held)") in a testnet review organization, so the flow runs end to end on testnet. While it is pinned (`TESTNET_GENESIS` in `server/reviewLog.ts`), a decision on live data counts for nothing and `pnpm review queue` says so: only test data can be released, and the two-person guarantee does not hold, because one party holds every key. Before any live data, independent reviewers seal a genesis in a review organization of their own and its hash replaces the pin; the testnet reviewers' decisions then stop counting.

## Setup (once)

The owner creates the review organization in CounterAudit. Each reviewer gets an ingest key and an individual read key to it; the Bureau gets a read key of its own.

- Where the Bureau runs: `COUNTERAUDIT_REVIEW_ORG_ID` (the organization's id) and `COUNTERAUDIT_REVIEW_READ_KEY`.
- On each reviewer's machine: `COUNTERAUDIT_REVIEW_INGEST_KEY`, their own.
- Both: `COUNTERAUDIT_API_URL` if not `https://api.counteraudit.io`.

The first reviewers then agree on a file listing each of them, in the same order for all:

```json
[
  { "reviewer_id": "rev_alice", "name": "Alice", "public_key": "ed25519:..." },
  { "reviewer_id": "rev_bob", "name": "Bob", "public_key": "ed25519:..." },
  { "reviewer_id": "rev_carol", "name": "Carol", "public_key": "ed25519:..." }
]
```

and each signs and seals it, within a day:

```sh
pnpm review key --key ~/bureau-review.pem --signer rev_alice --genesis reviewers.json --out genesis-alice.json
pnpm review submit genesis-alice.json
```

`key` prints the genesis hash. Each reviewer checks they all see the same hash, and a pull request sets `REVIEW_GENESIS` in `server/reviewLog.ts` to it. The genesis takes effect once that is deployed and all of them are sealed, in either order. A genesis that differs in any name, key or order has another hash.

The CounterAudit admin also marks the organization as the review organization, with the same hash (`PUT /v1/admin/review-org` with `{"genesis_hash": "<hash>"}`). From the moment that genesis takes effect there, CounterAudit counts the reviewers from the review log by the same rules, and creating or revoking any API key in the review organization, or changing that setting, needs reviewers' signed approvals of the exact request (below): one reviewer for a new key, two different reviewers for revoking a key or changing the setting. It also refuses a retention policy or erasure there, since the review log keeps every packet. Each reviewer can check which genesis CounterAudit pins and which reviewers it counts with their own read key: `GET /v1/audit/review-org`.

**Approving a key change in the review organization (a reviewer, on their own machine).** The operator makes the request in CounterAudit (`POST /v1/admin/keys`, `DELETE /v1/admin/keys/:id` or `PUT /v1/admin/review-org`), which answers 202 with an approval request, and hands the reviewer that request as `GET /v1/admin/keys/requests/:id` returns it:

```sh
pnpm review approve-key --key ~/bureau-review.pem --reviewer rev_alice --request request.json --out approval.json
```

It says what the request does (for example "create a key with role ingest, labelled "rev_dave ingest", expiring in 90 days") and signs `agent-bureau/key-approval/v1` over the request's id, organization, operation and the SHA-256 of its payload. Read that line before handing anything back. The operator sends the file to `POST /v1/admin/keys/requests/:id/reviewer-approval`. CounterAudit takes it if it comes from a reviewer it counts as active, signed with their current key, and dated in the life of the request, and runs the request once it has as many different reviewers' approvals as it needs; an approval from a reviewer suspended or re-keyed since stops counting. An approval approves that request and nothing else.

## Steps

**1. Make a key (each reviewer, once, on their own machine):**

```sh
pnpm review keygen ~/bureau-review.pem
```

This writes the private key (PKCS#8 PEM, readable only by its owner where the file system has permissions) and prints the public key, which the reviewer gives to the others for the genesis or an add. It refuses to overwrite a file. The private key never goes to the Bureau or into the repository; keep it on an encrypted disk. If it may have leaked, any reviewer can suspend it at once (below), and two can rotate it: every decision it signed stops counting.

**2. See what waits (operator, where the intake runs):**

```sh
pnpm review sync
pnpm review queue
```

`sync` reads the review log's new packets with the Bureau's read key, says what each reviewer-key record did, and settles every line. It stops at a gap in the chain, a packet of another organization, or one erased or not verified, keeps what came before, and exits 1. `queue` prints the sequence read to and the reviewers; then, for each line not withdrawn or superseded, the line, its outcome, data class and display state, its `signed_event_hash`, the proof and evidence results, the decisions sealed for it with their packets, what still holds it back, and a `sign with:` line with the arguments a decision needs.

**3. Decide and seal (each reviewer, on their own machine):**

```sh
pnpm review sign --key ~/bureau-review.pem --reviewer rev_alice \
  <the "sign with" arguments from the queue> --decision approve --out decision.json
pnpm review submit decision.json
```

`--decision` is `approve`, `approve_with_waiver` or `reject`; the last two need `--reason "..."` (up to 500 characters). `sign` writes the signed decision to a new file after checking it the way the Bureau will, against this key; whether it is the reviewer's current key is the log's to say. `submit` seals it in the review log with the reviewer's own ingest key, prints the packet and sequence, and writes CounterAudit's signed receipt beside the record (`decision.json.receipt.json`): keep it. It counts once the operator next runs `sync`. Seal a record within a day of signing it: a reviewer-key record sealed later counts for nothing. Exit code 0 when sealed, 1 when CounterAudit refused it, 2 when nothing was sent.

**Key changes (reviewers):**

```sh
pnpm review key --key ~/bureau-review.pem --signer rev_alice --suspend rev_bob --reason "key may have leaked" --out suspend.json
pnpm review key --key ~/bureau-review.pem --signer rev_alice --rotate rev_bob --public-key ed25519:... --out rotate.json
pnpm review key --key ~/bureau-review.pem --signer rev_alice --add rev_dave --name "Dave" --public-key ed25519:... --out add.json
```

and `--reenable rev_bob` or `--remove rev_bob` the same way; then `pnpm review submit` the file. A suspension takes effect at once. The others take effect when a second reviewer seals the same change (the same id, name and key; the reason may differ). Any change taking effect clears the votes still pending, so vote again for a change that was pending then.

## The signed decision

```json
{
  "schema": "agent-bureau/review-decision/v1",
  "reviewer_id": "rev_alice",
  "furnisher_id": "fur_levymerchant1",
  "event_id": "levy-sub8-charge1",
  "signed_event_hash": "<64 hex>",
  "data_class": "test",
  "evidence_digest": "<64 hex>",
  "decision": "approve_with_waiver",
  "reason": "checked the provider log",
  "decided_at": "2026-10-31T11:00:00.000Z",
  "signature": "ed25519:<86 base64url characters>"
}
```

The signature is Ed25519 over `agent-bureau/review-decision/v1\n` followed by the RFC 8785 canonical JSON of the decision without `signature`, the same construction as outcome event v1 with its own domain. Only the canonical base64url spelling is accepted. `evidence_digest` is the SHA-256 of the line's stored evidence result in canonical JSON. A decision dated more than 5 minutes after CounterAudit sealed it does not count. Reviewer-key records are signed the same way under `agent-bureau/reviewer-key/v1` (`docs/review-log-design.md`, Records).

The `outcome_reviews` table (migration 0009), where `pnpm review apply` recorded decisions the operator relayed, is no longer read: a decision recorded there counts only once its reviewer seals it in the log.

## Limits

- **CounterAudit's operator.** Whoever runs CounterAudit's server and database can still change them directly. The review organization's key changes need a reviewer's signature in CounterAudit's code path and are kept on record (`ca_review_org_history`, approval requests), and reviewers can compare what CounterAudit counts with what they read themselves; neither stops someone with root on the server.
- **Before the genesis takes effect** an admin issues the review organization's keys and sets its pinned genesis alone, so check `GET /v1/audit/review-org` once it does.
- **No reviewer-side check yet.** A reviewer compares the queue with the log using their own read key through CounterAudit's API; `pnpm review` has no command for it.
- **One run at a time.** `pnpm review sync`, `pnpm review settle` and the intake do not lock lines against each other; run them one after the other.
- **Command line only.** There is no review screen in the inbox.
- **No passphrase on private keys.**
- **Not yet covered:** subject matching changes (Phase 0 item 6 names them too; subject matching is Phase 3). Released lines appear on an agent's file (`docs/agent-file.md`).
