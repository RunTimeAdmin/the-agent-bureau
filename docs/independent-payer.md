# What a settled payment proves, and an independent payer

```
Status:     proposed, 2026-10-31. Design only; nothing here is built.
Answers:    external review finding M-04 (chain-confirmed payment is not an independent customer relationship)
Relates to: docs/evidence-verifier.md, docs/two-person-review.md, docs/bureau-spec.md (market test)
```

## The problem

The Arc/Levy evidence check proves that a payer wallet paid a vetted merchant account of the furnisher, in a final block, for the stated amount. It refuses a payer that is the merchant or one of the furnisher's listed accounts. It cannot tell whether the payer wallet belongs to the furnisher through an account it never listed. A furnisher can pay itself from such a wallet, report the payer as the subject, and pass every check. On testnet the USDC is free, so this costs nothing.

That is not an attack on a file today: the Bureau assembles no files, and wallets are not yet matched to agents (Phase 3). It becomes one the moment a file presents such a line as independent payment history.

## 1. Name what each check proves

Keep each result granular, and never let one word stand for more than its check shows:

| State                                                                         | Means                                                                                                                | Does not mean                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `payment_settlement_verified` (today's evidence `verified` for `paid`)        | A transfer of this amount from this payer wallet to the furnisher's vetted merchant account settled in a final block | That the payer is an independent customer, who controls the wallet, or that the service was delivered |
| `payment_failure_verified` (today's evidence `verified` for `payment_failed`) | A Levy charge for this amount failed on chain                                                                        | Why it failed, or that the payer owed it                                                              |
| reviewed (`two_person`, `solo_test`)                                          | Listed reviewers released the line                                                                                   | Anything beyond what they were shown                                                                  |
| `independent_payer_confirmed` (new, not built)                                | The checks in section 2 passed                                                                                       | That the relationship was good, or that the service was delivered                                     |

The evidence code keeps its `verified` status for compatibility, but documents, review prompts and any future file use these names. A file line shows each state it has and labels what it lacks.

## 2. What makes a payer independent

A payer is independent of the furnisher when the furnisher and its affiliates do not control the payer wallet or the agent behind it. That cannot be proven outright; it is supported by layers, each stronger than the last:

1. **Merchant vetting** (built). The charge's merchant is the furnisher's vetted account, and the payer is none of its listed accounts.
2. **Subject control** (Phase 3). The agent operator named as the subject proves control of the payer wallet, or of a registry identity that lists it. A line whose payer is not linked to its subject this way never shows as independent.
3. **Funding screen** (machine, flags only). The verifier traces where the payer's USDC came from, a bounded number of hops back over a bounded window, and flags the line for review when:
   - the funds came from the furnisher's merchant or listed accounts, or from a wallet that also funded them;
   - payer and merchant pay each other in both directions;
   - the payer wallet is new, or pays only this merchant;
   - the same payer pays several merchants of one furnisher.
     A flag sends the line to review with the reasons; it is not a verdict.
4. **Furnisher attestation.** Furnisher terms state that reported payers are arm's-length customers, and a furnisher found reporting its own wallets loses its vetted accounts.
5. **Reviewer checklist.** Approving a `paid` line includes confirming the funding screen's result, and a reviewer can reject on relatedness alone.

## 3. What files say

Every file that shows payment lines carries, in plain words: a settled payment proves that money moved between two wallets, not who controls them or whether the service was delivered. Lines without subject control or a funding screen are labelled as such.

## 4. Testnet

Testnet USDC is free, so testnet lines show nothing about wash resistance and are never used to claim it. The market test in `docs/bureau-spec.md` already counts only arm's-length furnishers; the same rule applies to payers.

## Decisions for the owner

1. The state names in section 1, and whether evidence `verified` is renamed in code now or only in documents.
2. The definition of independence in section 2.
3. For the funding screen: hop count, time window and thresholds, and whether a flag sends the line to review (proposed) or fails it.
4. The disclosure wording in section 3.

## Build outline

1. Documents and review prompts use the section 1 names (small; can go first).
2. Funding screen in `server/evidence.ts`, read-only, with recorded Arc fixtures for each flag.
3. Subject control, with Phase 3.
4. File assembly shows the states and the disclosure.
