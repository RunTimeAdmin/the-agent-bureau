# Independent review log

```
Status:     decided by the owner, 2026-10-31: option A, with the governance and disclosure
            below, and the build choices in "Build design". Built: steps 1 to 4 (step 2
            on 2026-10-31). Not built: the redacted release bundle (with file assembly).
Answers:    external review finding M-03 (the operator can suppress a reviewer's rejection)
Relates to: docs/two-person-review.md, Phase 0 decision 6 (two-person review)
```

## The problem

Reviewers sign their decisions on their own machines (`pnpm review sign`) and send them to the operator, who records them with `pnpm review apply`. The signatures stop anyone forging or altering a decision, and every settle re-checks them. But the operator chooses which signed decisions reach the Bureau. Leaving out a reviewer's newer rejection keeps their earlier approval in force, and the reviewer can only find out by asking the operator to run `pnpm review queue`. For a negative or disputed line shown to a third party, the second reviewer's veto is then only as independent as the operator.

## What a fix must give

1. Every valid signed decision is recorded somewhere the Bureau operator cannot drop, reorder or rewrite it.
2. A line's release state is derived from that record, and anyone holding the record can derive it again.
3. A reviewer can confirm their decision was recorded, and see the current release state, without asking the operator.
4. The signatures and the binding to event hash, data class and evidence digest stay as they are. No admin checkbox replaces them.

## Options

### A. CounterAudit as the log (recommended)

A dedicated CounterAudit organization, "Bureau review log", with a connector `agent-bureau-review-v1`. Each reviewer holds their own API key for that organization with only the `ingest` role (CounterAudit already scopes keys to `ingest`, `read` and `admin`). `pnpm review sign` gains a `submit` step that sends the signed decision straight to CounterAudit, which:

- checks the decision against the reviewer keys registered in that organization, the way it checks furnisher keys for outcome events;
- seals the whole signed decision in the organization's hash chain;
- returns a signed receipt to the reviewer and serves a public proof of the packet.

The Bureau reads the review organization's chain with a `read` key and derives release from every sealed decision in it, using the same rule as today (`releaseFor`). It records nothing it did not read from the chain. A file line cites the review packets that released it.

What this gives:

- **No silent omission.** A decision exists once CounterAudit seals it; the operator never handles it. The chain's sequence numbers and signed checkpoints show whether the Bureau's view includes every packet up to a point.
- **Reviewer self-check.** The receipt proves the decision was sealed at a position. With a `read` key for the review organization (or a published list of review packet proofs), a reviewer can recompute any line's release state themselves.
- **Reuse.** CounterAudit already provides sealing, signer registration, receipts, public proofs and checkpoints.

What it still needs:

- **Who administers the review organization.** Its admin can register or revoke reviewer keys. That must not be the Bureau operator alone. Decided: two of three independent reviewers for each key change, and any one reviewer may suspend a key at once (below).
- **A rule for decisions sealed while the Bureau's reader is behind.** Release is computed from the chain up to a stated sequence, and a file says which.
- **A CounterAudit connector and signer registry for reviewers**, in the style of the outcome-event path.

### B. A review endpoint on the Bureau

Reviewers post signed decisions to a Bureau endpoint that appends them to an insert-only table and returns a signed receipt. This is simpler, but the same operator still runs the server and the database, so it moves the trust rather than removing it. Receipts help a reviewer prove later that a decision was accepted, not stop it being ignored.

### C. A public repository of decisions

Each decision is committed to a public Git repository, and the Bureau derives release from it. History is visible and mirrors detect rewrites, but the repository's admin (likely the operator) can still force-push, and it publishes every decision, including reasons, to everyone.

## Recommendation

Option A. It removes the operator from the path, reuses CounterAudit's proofs and checkpoints, and keeps the decision format unchanged. Until it exists, the limits in `docs/two-person-review.md` stand, and no live line is released.

## Decisions (owner, 2026-10-31)

1. **Option A**: a dedicated CounterAudit review organization.
2. **Governance.** The Bureau operator may run the service but cannot administer reviewer keys alone. Adding, rotating or re-enabling a reviewer key needs two of three independent reviewers. One reviewer may suspend a key they suspect is compromised, at once; release states that rest on that key are held until the quorum resolves it.
3. **Read keys.** Each reviewer has an individual `read` key to the review organization, and the Bureau service a separate read-only key of its own. Nothing is published for reviewers to check against.
4. **Disclosure.** Subscribers receive a verifiable, redacted release bundle for a line. The full review packets, and reviewers' private notes, go only to the line's subject and the reviewers.

Beyond the outline below it needs: a two-of-three reviewer quorum for key changes, which CounterAudit's admin approvals do not provide today; immediate single-reviewer suspension, with release held until the quorum decides; and the redacted release bundle and its verification.

## Build design (owner's choices, 2026-10-31)

The owner chose four things for the build: the first reviewers come from a genesis record in the review chain, signed by each of them; creating or revoking CounterAudit API keys in the review organization needs a reviewer as second approver; that approval is signed with the reviewer's own review key over the exact request; and the redacted release bundle is built with file assembly, from what this build records.

### Where authority lives

CounterAudit checks the form of each record and seals it whole. It does not decide whose key counts: the Bureau works that out from the review chain alone, by the rules below, and so can anyone holding a read key. The operator can run both services and still cannot add, change or drop a reviewer, approve for one, or keep a decision out of the count.

### Records

Every record is a JSON object signed by one reviewer with Ed25519 over the schema name, a newline, and the RFC 8785 canonical JSON of the record without `signature`, the same construction as a review decision. Reviewers submit them straight to the review organization with their own ingest key (`pnpm review submit`), under the connector `agent-bureau-review-v1`, and keep CounterAudit's receipt.

- **A review decision**: `agent-bureau/review-decision/v1`, unchanged (`docs/two-person-review.md`).
- **A reviewer-key record**: `agent-bureau/reviewer-key/v1`, with `signer_id` (the reviewer signing it), `change` (below), `decided_at` and, for a suspension or removal, an optional `reason`. A change is one of:
  - `{"type": "genesis", "reviewers": [{"reviewer_id", "name", "public_key"}, ...]}`: the first reviewers, at least three;
  - `{"type": "add", "reviewer_id", "name", "public_key"}`;
  - `{"type": "rotate", "reviewer_id", "public_key"}`: a new key for a reviewer;
  - `{"type": "suspend", "reviewer_id"}`;
  - `{"type": "reenable", "reviewer_id"}`;
  - `{"type": "remove", "reviewer_id"}`.

### Rules

The Bureau reads the review chain in sequence order and applies each record as it comes:

1. **Genesis.** Only the genesis pinned in the Bureau's code counts: `REVIEW_GENESIS` in `server/reviewLog.ts`, the SHA-256 of its canonical `change`, set by pull request once the first reviewers agree on it. It takes effect once every reviewer it names has signed it with the key it names for them. Pinned, a genesis sealed first by whoever administers the review organization, naming the same reviewers with keys of their own, counts for nothing. A genesis after the first counts for nothing either. Until one has taken effect, no decision counts.
2. **Votes.** A record's signature must check against its signer's current key, and the signer must be a reviewer not removed. Identical changes (the same canonical `change`) from different reviewers are votes for one change. A record sealed again counts for nothing.
3. **Two of three.** `add`, `rotate`, `reenable` and `remove` take effect at the second vote from two different reviewers. Any change taking effect, a suspension included, clears every vote still pending, so a vote counts only toward the reviewers as they stood when it was cast.
4. **Suspension.** `suspend` takes effect at one reviewer's record, the suspended reviewer's own included. A suspended reviewer's decisions do not count, and no line on which they hold a current decision is released, until a re-enabling or a removal settles it. A rotation of their key settles it too: their decisions signed with the old key stop counting. Suspension holds a reviewer's decisions, not their vote, so no one key can suspend the others out of the quorum: two reviewers can always act. With two of three, two keys are the authority either way.
5. **Decisions** count when they check with the reviewer's current key, by a reviewer not removed; a suspended reviewer's decision holds its line instead (rule 4). A rotation therefore drops every decision signed with the old key, and the reviewer signs again what should stand. A decision sealed before the genesis took effect counts once it has. Each reviewer's latest decision counts, as today.
6. **Time.** A record dated more than 5 minutes after CounterAudit sealed it counts for nothing, and so does a reviewer-key record sealed more than a day after it was signed. CounterAudit's order and times are trusted.

### Reading the chain

`pnpm review sync` reads the review organization with the Bureau's own read key: the packets it does not hold yet (`GET /v1/audit/packets`, then `GET /v1/audit/verify/:packet_id` for each sealed record, which CounterAudit checks against its seal). It checks each belongs to the organization, that the chain starts at sequence 0, and that each packet's sequence and previous hash follow the one before, and stores each packet's sequence, hashes and record. It reports a gap rather than reading past it. Release is computed from the stored chain up to the first gap; `pnpm review queue` prints that position and each counted decision's packet, so a reviewer can compare them with the chain head they see with their own read key. `pnpm review apply` is retired: nothing the operator hands over counts.

### CounterAudit

- **The connector** `agent-bureau-review-v1`, global like `agent-bureau-outcome-v1`. It refuses a record that is not one of the two forms above, seals the signed record in the packet body, and returns a receipt. Review packets are not public (`public_proof` is refused): reasons are for the subject and the reviewers.
- **Signed approvals for the review organization's keys.** Creating or revoking any API key in the review organization needs a reviewer's approval. CounterAudit's approvals today go through its admin plane, which answers only on the server, as a one-time code: a code shows the approver was there, not which request they meant, so one relayed through the operator could approve another request. Here an approval is instead a record signed with the reviewer's own review key over the request's id, operation and payload, which the operator can carry to CounterAudit but cannot spend on anything else. CounterAudit checks it against the reviewer set the review chain itself establishes, by the rules above. CounterAudit's key approvals are one global setting today (`CA_KEY_APPROVAL_THRESHOLD`), so this is also the first per-organization rule.

### Not in this build

- The redacted release bundle for subscribers, which comes with file assembly; the files the Bureau assembles do not exist yet. The chain position a file's release rests on is recorded with it then.
- A reviewer-side command that replays the chain with the reviewer's own read key.

## Build outline

1. CounterAudit: the connector and its two record forms. Tests that a malformed record, a public proof and the outcome fields are refused.
2. CounterAudit: signed approvals for the review organization's API keys, checked against the reviewer set its chain establishes. Tests that a key change without a reviewer's signed approval, or with one for another request, is refused. Built 2026-10-31 with the owner's choices: which org is the review organization, and which genesis counts there, is a stored setting in CounterAudit that reviewers must approve changing once a genesis has taken effect; in that org a retention policy and erasure are refused outright; a new key takes one reviewer's approval, and revoking a key or changing the setting takes two different reviewers', so one reviewer and the operator can neither end the governance nor cut another reviewer off. The approval is `agent-bureau/key-approval/v1` (`server/keyApproval.ts`, `pnpm review approve-key`). CounterAudit's port of the rules runs the same shared vectors (`server/fixtures/review-vectors/review-log-v1.json`, built by `pnpm review:vectors`).
3. Bureau: the reviewer-key records (`pnpm review key`, with `--genesis` for the first reviewers), `pnpm review submit`, `pnpm review sync`, the rules above in release computation, and the chain position in `pnpm review queue`. `pnpm review apply` is retired.
4. Tests: a decision the operator never relayed still counts; a reviewer's newer rejection holds although the operator does nothing; a gap in the chain is reported, not read past; one vote changes nothing and two do; a suspension holds a line at once; a genesis not signed by everyone it names counts for nothing.
