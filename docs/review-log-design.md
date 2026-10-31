# Independent review log

```
Status:     proposed, 2026-10-31. Design only; nothing here is built.
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

- **Who administers the review organization.** Its admin can register or revoke reviewer keys. That must not be the Bureau operator alone: at least one reviewer, or a second admin under CounterAudit's approval rules, has to agree to each change.
- **A rule for decisions sealed while the Bureau's reader is behind.** Release is computed from the chain up to a stated sequence, and a file says which.
- **A CounterAudit connector and signer registry for reviewers**, in the style of the outcome-event path.

### B. A review endpoint on the Bureau

Reviewers post signed decisions to a Bureau endpoint that appends them to an insert-only table and returns a signed receipt. This is simpler, but the same operator still runs the server and the database, so it moves the trust rather than removing it. Receipts help a reviewer prove later that a decision was accepted, not stop it being ignored.

### C. A public repository of decisions

Each decision is committed to a public Git repository, and the Bureau derives release from it. History is visible and mirrors detect rewrites, but the repository's admin (likely the operator) can still force-push, and it publishes every decision, including reasons, to everyone.

## Recommendation

Option A. It removes the operator from the path, reuses CounterAudit's proofs and checkpoints, and keeps the decision format unchanged. Until it exists, the limits in `docs/two-person-review.md` stand, and no live line is released.

## Decisions for the owner

1. Option A, B or C.
2. For A: who administers the review organization, and whether key changes need a reviewer's approval.
3. For A: whether reviewers get a `read` key to the review organization, or the Bureau publishes the list of review packet proofs.
4. Whether a file line shows the review packets that released it to subscribers, or only to the subject and reviewers.

## Build outline (option A)

1. CounterAudit: the `agent-bureau-review-v1` connector, a reviewer key registry (registration under approvals), sealing of the full signed decision, receipts and public proofs. Tests that a decision signed by an unregistered or revoked key is refused.
2. Bureau: `pnpm review submit` on the reviewer's machine, and a reader that pulls the review organization's chain into release computation, recording the last sequence read. `pnpm review apply` is retired.
3. Bureau: `pnpm review queue` shows, per line, the review packets it counted and the chain position it read up to.
4. Tests: a decision the Bureau never relayed still counts; a reviewer's newer rejection holds even if the operator does nothing; a gap in the chain the Bureau has read is reported, not skipped.
