# What a settled payment proves, and an independent payer

```
Status:     decided by the owner, 2026-10-31 (below). Documents and review prompts use these
            names, and the funding screen is built (section 2); subject control is not.
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
| `subject_control: proven \| unproven` (new, not built)                        | The subject proved control of the payer wallet, or of a registry identity that lists it (section 2, layer 2)         | That the payer is independent of the furnisher                                                        |
| `payer_independence_screen: clear \| flagged \| inconclusive` (new, not built) | The funding screen's result (section 2, layer 3)                                                                     | That the payer is independent: `clear` means the screen found nothing, within its limits              |

There is no state that confirms a payer is independent: no check here can prove who owns a wallet or that a relationship is arm's length, so each layer reports only what it saw. The evidence code keeps its `verified` status for compatibility, but documents, review prompts and any future file use these names. They become the user-facing states in code before any external file or API goes live. A file line shows each state it has and labels what it lacks.

## 2. What makes a payer independent

A payer is independent of the furnisher when the furnisher and its affiliates do not control the payer wallet or the agent behind it. That cannot be proven outright; it is supported by layers, each stronger than the last:

1. **Merchant vetting** (built). The charge's merchant is the furnisher's vetted account, and the payer is none of its listed accounts.
2. **Subject control** (Phase 3). The agent operator named as the subject proves control of the payer wallet, or of a registry identity that lists it. `subject_control` is `proven` only then, and `unproven` otherwise.
3. **Funding screen** (machine, flags only). The verifier traces where the payer's USDC came from, two hops back over 30 days, reading at most 50 USDC transfer-log entries per wallet per hop, and flags the line for review when:
   - funds trace to the furnisher or its listed accounts;
   - payer and merchant have transferred to each other in both directions;
   - the payer wallet was first seen within the last 30 days;
   - the payer made no other observed merchant payments in the window;
   - one payer paid three or more merchants linked to the same furnisher within 30 days.
     `payer_independence_screen` is `flagged`, with the reasons, when any of these holds, `inconclusive` when a cap was hit or the history is incomplete (never a clean result), and `clear` otherwise. A flag or an inconclusive result sends the line to human review; it never fails the line.
4. **Furnisher attestation.** Furnisher terms state that reported payers are arm's-length customers, and a furnisher found reporting its own wallets loses its vetted accounts.
5. **Reviewer checklist.** Approving a `paid` line includes confirming the funding screen's result, and a reviewer can reject on relatedness alone.

## 3. What files say

Every file carries: "A settled payment proves that money moved between two wallets, not who controls them or whether the service was delivered." Lines without subject control or a funding screen are labelled as such.

## 4. Testnet

Testnet USDC is free, so testnet lines show nothing about wash resistance and are never used to claim it. The market test in `docs/bureau-spec.md` already counts only arm's-length furnishers; the same rule applies to payers.

## Decisions (owner, 2026-10-31)

1. **The layered screen is approved**, with the names in section 1: `payment_settlement_verified` for what the chain proves, and `subject_control` and `payer_independence_screen` as separate fields instead of one `independent_payer_confirmed`, which would claim more than the checks can show. Documents and review prompts use them now; they become the user-facing states in code before any external file or API goes live.
2. **Independence** as section 2 defines it.
3. **The funding screen** as section 2 sets it: two hops, 30 days, 50 transfer-log entries per wallet per hop, the five flags, inconclusive on a cap or incomplete history, and human review for every flag, never automatic failure.
4. **The disclosure** in section 3, in every file.

## Build outline

1. Documents and review prompts use the section 1 names. Done: `pnpm review queue` shows them for payment lines, with the disclosure and the checklist in section 2, layer 5.
2. Funding screen. Done: `server/fundingScreen.ts`, described in `docs/evidence-verifier.md` (Funding screen), with a test for each flag and a recording of Arc's explorer for a real Levy charge.
3. Subject control, with Phase 3.
4. File assembly shows the states and the disclosure.
