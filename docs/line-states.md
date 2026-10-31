# Line states

What the Bureau knows about each stored line, kept as separate facts instead of one "verified" bit, and how a furnisher's later line can withdraw, replace or dispute an earlier one. Code: `server/lineState.ts`, applied by the operator intake (`docs/counteraudit-intake.md`).

## States

| State               | True when                                                                                      | Source                      |
| ------------------- | ---------------------------------------------------------------------------------------------- | --------------------------- |
| `sealed`            | Always, for a stored line: CounterAudit sealed it as a packet.                                 | CounterAudit ingest         |
| `source_signed`     | The packet's public proof passed every check, including the furnisher's signature (`proofOk`). | `server/outcomeProof.ts`    |
| `evidence_verified` | The evidence check returned `verified` (`evidenceStatus`).                                     | `docs/evidence-verifier.md` |
| `disputed`          | A later line from the same furnisher `disputes` it.                                            | Furnisher relation          |
| `withdrawn`         | A later line from the same furnisher `withdraws` it.                                           | Furnisher relation          |
| `superseded`        | A later line from the same furnisher `supersedes` or `corrects` it.                            | Furnisher relation          |

Each fact stays readable on its own. A line can be source signed with evidence still under review, or evidence verified and withdrawn.

## Display state

The stored `displayState` (Phase 0 decision 4) follows from the states. A withdrawal outranks a replacement, which outranks a dispute:

1. `withdrawn`
2. `superseded`
3. `disputed`
4. `unverified`

`verified` is never set yet. It will need a passing proof, verified evidence (or a reviewed waiver), and two-person review, which comes in the next change. Until then the best a line can show is `unverified`.

## Relations

An outcome event v1 may carry `relation: {type, target_event_id}`. The Bureau looks the target up among the **same furnisher's** lines, so a furnisher can only act on its own lines. A relation takes effect only when:

- the relating line's own proof passed, so the furnisher really sent it;
- it names the same subject as its target (EVM wallets compare without case; other subject forms must match exactly);
- both lines have the same data class, so test data can never change a live line;
- it does not point at itself.

When a relation cannot act, the intake reports why, and the target is settled without it. A relation can arrive before its target: the intake settles each line it stores against the relations already waiting for it. Re-running a file re-settles every line in it and its targets. That is how a relation whose proof was not checked the first time takes effect later, and how one whose proof no longer passes stops acting. Event ids match with exact case, as in CounterAudit, although the database columns compare without case.

**Withdrawing a relating line** (owner decision, 2026-10-31). If a furnisher withdraws its own dispute, the dispute ends and the disputed line goes back to `unverified`. A withdrawn correction, replacement or withdrawal stays in force: to bring an earlier line back, the furnisher sends a new line. The file only ever narrows, apart from a dispute ending. The intake carries such a change along the chain of relations, up to 10 lines.

A withdrawal, a replacement or a furnisher's own dispute takes effect without review, since each only narrows what the file says. A correction's new line goes through every check like any other line. The relating line is kept as its own line; showing it in the file's history is part of assembling files, which is not built.

## Not covered yet

- **Subject disputes.** The spec has the subject dispute by signing with the wallet that controls the agent. That needs subject matching (Phase 0 decision 3) and its own intake. Today only a furnisher's `disputes` relation marks a line disputed.
- **Two-person review**, the review queue and evidence waivers: the next change.
- **Dispute deadlines.** The furnisher's 15 days to confirm, correct or withdraw a disputed line.
- **Event ids that differ only in case.** The unique index on furnisher and event id compares without case, so the Bureau cannot store two events from one furnisher whose ids differ only in case; the second fails to store with a duplicate-key error. Fixing that needs a binary collation on those columns.
