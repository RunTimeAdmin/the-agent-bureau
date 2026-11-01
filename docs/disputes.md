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
pnpm dispute sign <record.json> --wallet-key <file>     # testing only: a subject's real wallet signs it
pnpm dispute submit <signed.json>                       # seal it and record it
pnpm dispute settle                                     # close lapsed disputes; run daily
pnpm file subject --subject '{"wallet":"0x..."}' --out <file>
```

`pnpm dispute submit` and `settle` need the same settings as the intake (`COUNTERAUDIT_ORG_ID`, `COUNTERAUDIT_INGEST_KEY`, `DATABASE_URL`).

## Not built yet

- A page where subjects file and sign disputes themselves; today they sign a file and send it to the operator.
- Disputes on lines about a registry id, and on Sigvara or Nooscape records, which are contested through their own processes.
- Counting lapsed disputes against the furnisher (`bureau-spec.md`): they are listed in the queue, not yet scored.
