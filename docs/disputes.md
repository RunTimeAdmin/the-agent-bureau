# Disputes from the subject

How the subject of a line disputes it, how the furnisher answers, and how either side appeals, as built for Phase 0 (decisions of 1 November 2026: a signed file the operator runs, every step sealed through a CounterAudit connector, appeals decided by reviewers). It implements `bureau-spec.md`, "Disputes". A furnisher's own `disputes` relation (`docs/line-states.md`) is a different thing and is unchanged.

## Records

Every step is a signed JSON record, schema `agent-bureau/dispute/v1`, with a `kind`. Each is signed over `agent-bureau/dispute/v1\n` followed by the RFC 8785 canonical record without its `signature`, so nothing else either key signs can pass for one.

| Kind | Signed by | Fields besides `schema`, `kind`, `dispute_id`, `signature` |
| --- | --- | --- |
| `dispute` | The subject's wallet (EIP-191 `personal_sign`) | `line` (`furnisher_id`, `event_id`, `signed_event_hash`), `subject_ref` exactly as on the line, `signer` (the wallet address), `reason` (1 to 500 characters), optional `evidence` (up to 5 of `{tx_hash}`, `{url}` or `{note}`), `filed_at` |
| `response` | The furnisher's key (Ed25519, as for outcome events) | `furnisher_id`, `key_id`, `response` (`confirm`), `evidence` (at least one item), `responded_at` |
| `statement` | The subject's wallet | `signer`, `text` (1 to 500 characters), `stated_at` |
| `appeal` | Either party, as above | `party` (`subject` or `furnisher`), `signer` or `furnisher_id` and `key_id`, `reason`, `appealed_at`; a furnisher's also names its `corrective_event_id` |

`dispute_id` is a UUID the subject's tool picks; every later record names it. Times are ISO 8601 UTC with milliseconds.

A wallet signature proves control of the wallet the line names. A line about a `did:sigvara` subject is disputed with the wallet registered as that agent's address in SigvaraIdentity, read at the finalized block when the dispute is filed. Other subject forms (a registry id) cannot be disputed yet: matching them to a key is Phase 3.

## Sealing and checking

The operator seals each record in the Bureau's CounterAudit organization through the connector `agent-bureau-dispute-v1`, which checks the record's form and seals it whole, as the review connector does. The Bureau checks the signatures itself (`server/dispute.ts`): the subject's against the wallet the line names, the furnisher's against the key that signed the disputed line or a key `server/furnishers.ts` lists for that furnisher. A record whose signature does not check is sealed and then counts for nothing. Dispute records are never public: they hold the subject's reasons. They take the organization's 24-month retention, like the lines.

## What happens

1. **Filed.** A checked `dispute` on a released or disputed line shows the line as `disputed` at once, on every file assembled after, with the date and the furnisher's deadline: 15 days from when the record was sealed. A line can carry one open dispute at a time.
2. **The furnisher answers** within the 15 days in one of three ways:
   - it corrects or withdraws the line with a later outcome event (`corrects`, `supersedes` or `withdraws`, `docs/line-states.md`). The dispute closes as `corrected` or `withdrawn`;
   - it `confirm`s with evidence. The line stays, shown as disputed and confirmed by the furnisher, and the subject may add one `statement`, which the file shows beside it. Where the line's evidence was machine-checked (`docs/evidence-verifier.md`), that check stands as the on-chain evidence; anything else is for reviewers on appeal;
   - it does nothing. The dispute closes as `lapsed` and the line is `removed`: it leaves every file, history included, and cannot be released again. The furnisher's route back is a new event that corrects it, which goes through intake and review like any line, and which the subject can dispute in turn.
3. **Appeal.** Either party may appeal once per dispute, with a reason, after the furnisher has answered or the dispute has lapsed. The appeal is sealed, listed in `pnpm review queue` for reviewers, and decided through the review log as releases are, by decisions sealed after the appeal:
   - the subject's appeal against a confirmed line is upheld by a reviewer's rejection of the line, which holds it off every file (any current rejection does, `docs/two-person-review.md`), and dismissed when the reviewers a release needs approve the line again;
   - the furnisher's appeal against a removal names its corrective line, a new event that `corrects` the removed one. It is upheld when reviewers release that line and dismissed when one rejects it. The removed line stays removed either way.
   Until then the appeal is open and the line stays as it was.

Every step is in CounterAudit's sealed chain, so the subject's view and an auditor see the same timeline.

## The subject's view

`pnpm file subject` writes, for one subject, every line the Bureau holds on them that was ever released, with what a file leaves out: the furnisher's name, the signed event, the CounterAudit packet and proof, what the evidence check proved and what it did not (subject control is unproven until Phase 3), the payer-independence screen, how reviewers released it and each decision's review-log packet, the line's correction history (every line relating to it), each dispute's records and state, and how to dispute or appeal. The operator sends it to the subject on request, free, as `bureau-spec.md` requires.

## Running it

```bash
pnpm dispute sign <record.json> --wallet-key <file> --out <file>     # testing only: a subject's real wallet signs it
pnpm dispute sign <record.json> --furnisher-key <file> --out <file>  # testing only: a response or a furnisher's appeal
pnpm dispute submit <signed.json>                                    # seal it and record it
pnpm dispute settle                                                  # close lapsed disputes; run daily
pnpm file subject --subject '{"wallet":"0x..."}' --out <file>
```

`pnpm dispute submit` needs the same settings as the intake (`COUNTERAUDIT_ORG_ID`, `COUNTERAUDIT_INGEST_KEY`, `DATABASE_URL`); `settle` seals nothing and needs only `DATABASE_URL`. `pnpm file subject` needs what `pnpm file assemble` does, without a file key. The shared vectors for the connector's form are `server/fixtures/dispute-vectors/dispute-records-v1.json` (`pnpm dispute:vectors` rebuilds them).

## Choices in the code

Where the sections above are silent, `server/dispute.ts` and `pnpm dispute` decide as follows.

- **Times.** A record's own times (`filed_at` and the rest) are its signer's claim, checked only for their form and that `Date.parse` reads them, as the connector checks them. Deadlines and order come from when CounterAudit sealed each record. The furnisher's answer counts if it was sealed before the deadline, and the dispute lapses at the moment the 15 days are up. A line that withdraws, corrects or replaces the disputed one counts the same way, by its own seal time. Nothing sealed after the deadline changes a lapse.
- **Several answers.** A withdrawal outranks a correction or replacement, which outranks a confirmation, in whatever order they came. The first confirmation counts, and after it the subject's first statement.
- **Filing.** Every dispute has a new `dispute_id`. `subject_ref` must be the line's exactly, as canonical JSON, and `line` must name the version of the event the Bureau holds. Only a line on a file can be disputed: released by reviewers and shown as `released` or `disputed`. A line whose dispute was confirmed can be disputed again; a file shows the latest dispute on a line, or the one that lapsed. A file's `filed_at` is when CounterAudit sealed the dispute.
- **Who signs.** Each record from the subject (a dispute, a statement or an appeal) is checked against the line's subject when it is submitted. For a `did:sigvara`, the agent address is read at the latest finalized block on Arc testnet for each such record and stored with it; an agent not registered there cannot dispute. A furnisher's record must name the line's furnisher and be signed with the key the line's signed event names, as CounterAudit's receipt for the line shows it (the receipt carries the same signer as the public proof), or with a key `server/furnishers.ts` lists: an active one when the record is submitted, and the same key after it is revoked, as stored lines keep their checks.
- **Checking again.** Every settle, file, `pnpm review queue` and subject view checks each stored record again from the record itself: its form and signature, the subject's against the line's subject. The one stored value those checks rely on is the agent address read from SigvaraIdentity for a `did:sigvara`, and it counts only if it is the DID's own address: SigvaraIdentity forms the DID from the agent address and never changes it, so a genuine read always is, and an address edited into the row counts for nothing. What the checks found at submission is kept beside each record and never decides anything, so a row whose stored result was edited counts for nothing, as an edited review decision does (`docs/two-person-review.md`).
- **Retention.** When `pnpm lines expire` erases a line, it erases the same from the line's dispute records: the record, CounterAudit's receipt, the agent address and the text of why a check failed, which names wallets. Each row keeps its ids, kind, packet, sequence, seal time and what its checks found at submission. An erased record counts for nothing.
- **Appeals.** The subject appeals a confirmed dispute, after the confirmation. The furnisher appeals a lapsed one, after the deadline, naming a stored line of its own that `corrects` the removed one. One appeal counts per dispute, whichever party makes it. A review decision counts for an appeal when the review log sealed it after CounterAudit sealed the appeal, comparing the two organizations' seal times. Each reviewer's latest such decision counts, and a current rejection decides the appeal even beside approvals.
- **What submit refuses.** It sends nothing, and exits 2, for a record that fails the connector's form, names a line or dispute the Bureau does not hold or a dispute that counted for nothing, reuses a `dispute_id`, names the subject otherwise, disputes a line not on a file or one with an open dispute, answers a dispute that is not open, adds a statement before the confirmation or a second one, or appeals out of turn or a second time. A record whose signature or subject control fails is sealed and stored, counts for nothing, and `submit` exits 1. When Sigvara cannot be read, nothing is sealed.
- **The subject's view.** A line was ever released when reviewers released it at some point in the review log's order, judged against its current evidence result, or when the subject disputed it. The furnisher is named by its `furnisher_id` and category: the Bureau holds no other name for it. The view is not signed.

## Not built yet

- A page where subjects file and sign disputes themselves; today they sign a file and send it to the operator.
- Disputes on lines about a registry id, and on Sigvara or Nooscape records, which are contested through their own processes.
- Counting lapsed disputes against the furnisher (`bureau-spec.md`): they are listed in the queue, not yet scored.
