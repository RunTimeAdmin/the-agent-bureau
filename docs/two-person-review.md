# Two-person review

No line shows as `verified` until reviewers release it (Phase 0 item 6). Each reviewer signs their decisions with their own key on their own machine; the Bureau holds only public keys and checks every decision, when it is recorded and every time a line is settled. Code: `server/reviewDecision.ts` (keys, signing, checks), `server/lineState.ts` (`releaseFor`), `server/settleLines.ts` (`reviewsFor`) and `server/review.ts` (`pnpm review`).

## Release rule

A line is released, and shows as `verified`, when all of these hold:

1. **Its proof passed**: CounterAudit sealed it and the furnisher's signature checked out (`source_signed`).
2. **Its evidence allows it.**
   - `verified` evidence: any approval counts.
   - `needs_review` evidence, which a person must judge (no machine check applies, or the check found something only a person can settle, such as a subject that is not a wallet, a merchant paying itself or a charge another line already claims): only an approval that waives it (`approve_with_waiver`, with a reason) counts.
   - `failed` evidence can never be waived. `pending`, `error` or no check yet: run the intake again first.
3. **No listed reviewer currently rejects it.**
4. **Enough approvals from different listed reviewers**: two for live data, one for test data (Phase 0 item 6 keeps the solo path for test data and dry runs). `pnpm review queue` reports a solo release as such, and a file must label it.

Each decision is signed for one line (`furnisher_id`, `event_id`), one version of its event (`signed_event_hash`), its data class, and the digest of its evidence result as the reviewer saw it (`evidence_digest`). A decision for another version or data class never counts. An approval counts only while the line's evidence result still has that digest: if a re-run of the intake changes it (a reused charge found, say), the approval stops counting and the line needs a new review. A rejection holds the line whatever evidence it was signed against.

Each reviewer's latest decision counts, ordered by the time they signed it, not the order it reached the Bureau. A reviewer changes their mind by signing a new decision.

A dispute, withdrawal or replacement (`docs/line-states.md`) outranks a release: a disputed line shows as `disputed` at once, whatever reviewers decided.

## What is trusted

Every settle reads a line's decisions from their signed form and checks each signature again against the reviewers listed now. The table's other columns are only for querying. So an edited or forged row does not count, a reviewer taken off the list stops counting, and so does every decision signed with a key that has since been replaced. A `displayState` written straight into the database is put back on the next settle.

## Reviewers

`REVIEWERS` in `server/reviewDecision.ts` lists each reviewer's id (`rev_` and 3 to 32 lowercase letters or digits), name and public key. It is code, so adding, removing or re-keying a reviewer is a reviewed pull request. Two ids may not share a key; the module refuses to load such a list. It is empty: until reviewers are listed, nothing can be released.

After any change to the list, run `pnpm review settle`.

## Steps

**1. Make a key (each reviewer, once, on their own machine):**

```sh
pnpm review keygen ~/bureau-review.pem
```

This writes the private key (PKCS#8 PEM, readable only by its owner where the file system has permissions) and prints the public key with the line to add to `REVIEWERS`. It refuses to overwrite a file. The private key never goes to the Bureau or into the repository; keep it on an encrypted disk. If it may have leaked, replace the listed key by pull request and run `pnpm review settle`: every decision it signed stops counting.

**2. See what waits (operator, where the intake runs):**

```sh
pnpm review queue
```

For each line not withdrawn or superseded it prints the line, its outcome, data class and display state, its `signed_event_hash`, the proof and evidence results, what still holds it back, and a `sign with:` line with the arguments a decision needs.

**3. Decide (each reviewer, on their own machine):**

```sh
pnpm review sign --key ~/bureau-review.pem --reviewer rev_alice \
  <the "sign with" arguments from the queue> --decision approve
```

`--decision` is `approve`, `approve_with_waiver` or `reject`; the last two need `--reason "..."` (up to 500 characters). It prints one signed JSON line. Before signing it checks the key against the reviewer's listed key, and checks the result the same way the Bureau will. Send the line to the operator; it holds no secret.

**4. Record (operator):**

```sh
pnpm review apply decisions.jsonl
```

For each line it checks the decision's form, reviewer, signature and time (not more than 5 minutes ahead), that the Bureau holds that exact event in that data class, and, for an approval, that the evidence has not changed since it was signed. It records each decision once and settles the line. Exit code 0 when every decision was recorded or already recorded, 1 when any was refused, 2 when nothing ran.

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

The signature is Ed25519 over `agent-bureau/review-decision/v1\n` followed by the RFC 8785 canonical JSON of the decision without `signature`, the same construction as outcome event v1 with its own domain. Only the canonical base64url spelling is accepted. `evidence_digest` is the SHA-256 of the line's stored evidence result in canonical JSON. Recorded decisions are kept whole in `outcome_reviews` (migration 0009), each once (`decisionHash`).

## Limits

- **The operator relays decisions.** An operator could leave a reviewer's newer rejection out of an apply file, so their earlier approval keeps counting. Reviewers should check `pnpm review queue` after their decision is applied. A published log reviewers can check without the operator would close this.
- **One run at a time.** `pnpm review apply` and the intake do not lock lines against each other; run them one after the other.
- **Command line only.** There is no review screen in the inbox.
- **No passphrase on private keys.**
- **Not yet covered:** subject matching changes (Phase 0 item 6 names them too; subject matching is Phase 3), and showing released lines on an agent's file (assembling files is not built).
