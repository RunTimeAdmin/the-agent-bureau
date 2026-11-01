# Evidence verifier: Levy on Arc testnet

A CounterAudit proof shows who signed an outcome event and that it was sealed. It does not show that the outcome happened. The evidence verifier checks that part against the chain, for the one path Phase 0 chose first (decisions 1 and 2): Levy's USDC subscription billing on Arc.

Code: `server/evidence.ts` (checks and registry) and `server/arcReader.ts` (RPC reads). The operator intake runs it on every line and stores the result (`docs/counteraudit-intake.md`).

## What it checks

| Outcome          | Must match                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `paid`           | A Levy `Charged` log, plus the USDC transfers that settled it: payer to Levy, Levy to merchant |
| `payment_failed` | A Levy `ChargeFailed` log                                                                      |
| anything else    | Nothing yet. The line goes to review.                                                          |

For a `paid` or `payment_failed` line the verifier needs `amount.chain` set to `arc-testnet`, `amount.asset` set to `USDC`, and `evidence.tx_hash`. It then checks, in order:

1. **Chain.** The RPC reports chain id 5042002.
2. **Finality.** The transaction's block is at or below the RPC's `finalized` block, and the RPC's block at that height has the receipt's block hash.
3. **Settlement status.** The transaction succeeded.
4. **Contract.** The log comes from Levy's registered SubscriptionManager. A `Charged` log from any other address is ignored.
5. **Token and transfers** (`paid`). Inside the same charge, the USDC ERC-20 contract logged a transfer of the charged amount from the subscriber to Levy, and of that amount less Levy's 1% fee from Levy to the plan's merchant. A charge paid entirely from proration credit moves no USDC and fails.
6. **Payer.** The subscription's subscriber, read at that block, is the event's `subject_ref.wallet`.
7. **Amount.** `amount.value` in USDC base units (6 decimals, no rounding) equals what was charged, or for a failed charge what was due (plan price less credit). What was due is read from state at the end of the block and at the end of the block before; if a plan change or payment in the same block makes them differ, the line goes to review.
8. **Log index.** Exactly one charge log in the transaction matches. The result records its index, so the line points at one log, not a whole transaction. A transaction with more than 20 charge logs of the kind goes to review unread, since each costs RPC reads and the furnisher picks the transaction.
9. **Recipient.** The plan's merchant is an account the furnisher was vetted for (below).
10. **Another party.** The payer is not the merchant or another of the furnisher's own accounts. A merchant paying itself goes to review.
11. **Time.** `occurred_at` is within 24 hours of the block's time. The furnisher's time is its claim; the block's time is the one recorded.
12. **Minimum.** The charge (or, for a failed one, what was due) is at least the token's `minimum` in the registry, 1 USDC. A smaller one is still checked, recorded and claimed, but the line goes to review: small charges cost little to manufacture in bulk.
13. **Age.** The charge settled less than 24 months before the check, the retention baseline. A line it backed before may have expired, and `pnpm lines expire` erases that line's claim on the charge, so without this one charge could back two lines (`docs/agent-file.md`, "When a line's source expires").

The intake adds one check the chain cannot answer: no other stored line already claims the same settlement log (`evidenceKey`: chain id, transaction and log index). A line claims a charge only when its CounterAudit proof passed and the charge's merchant is that furnisher's vetted account. Every Levy charge is public, so this keeps another furnisher from claiming a charge first to block the real line. One charge backs at most one line: a second line claiming the same charge gets `failed` evidence, which no reviewer can waive, and claims nothing (review M-02, 2026-10-31). A released line must also still hold its claim: a line backed by a charge whose claim it does not hold (an unvetted merchant, or a charge another line holds) is never released (`docs/two-person-review.md`). The one exception to one-line-per-charge is a correction: a line that `corrects` or `supersedes` the line holding the charge, from the same furnisher, with a passing proof, the same subject and the same data class, takes the claim over, and the line it replaces shows as `superseded`. `evidenceKey` is unique in the database, so two intake runs storing at once cannot both claim it; the one that writes second becomes the second line. A stored claim is never cleared by a later check, so a later result cannot free the charge for another line.

## Results

| Status         | Meaning                                                                                                                                                                                                                                                                         | Next                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `verified`     | Every check passed.                                                                                                                                                                                                                                                             | Still shown `unverified` |
| `failed`       | The chain contradicts the event: wrong amount, payer, merchant or time; reverted transaction; no matching Levy log. Or another line already backs the same charge.                                                                                                              | Kept, with reasons       |
| `needs_review` | No machine check applies: another outcome, chain or asset; no transaction hash; a subject that is not an EVM wallet; a furnisher with no vetted account; several matching charges; too many charge logs; a merchant paying itself; an amount due that changed within the block. | A person reviews it      |
| `pending`      | The transaction is not found yet, or its block is not finalized yet. A load-balanced RPC node can lag, so not found is not a verdict.                                                                                                                                           | Run the intake again     |
| `error`        | The chain could not be read, or the RPC was inconsistent (wrong chain, block hash mismatch).                                                                                                                                                                                    | Run the intake again     |

Documents and review prompts name a `verified` result by what it proves (`docs/independent-payer.md`): `payment_settlement_verified` for a `paid` or `refunded` line, a transfer that settled; `payment_failure_verified` for `payment_failed`, a charge that failed on chain. Neither shows who controls the payer wallet or that the service was delivered.

Every result keeps its reasons and, when a charge was found, what the chain showed: chain, transaction, log index, block number, hash and time, contract, token, subscription, payer, recipient and amount.

A `verified` result does not change how a line is shown. A line shows as `released` only once reviewers release it, which needs a passing proof and evidence `verified` or waived by every approving reviewer (Phase 0 decision 4, `docs/two-person-review.md`). Intake stays test-data only.

On a re-run the intake records a new evidence result only when the event is the one the line stores (same signed-event hash) and the check reached a verdict. A `pending` or `error` result never replaces an earlier one.

## Funding screen

A `paid` line whose charge settled, and did not fail its checks, is also screened for a payer related to the furnisher (review M-04; the rules and limits are in `docs/independent-payer.md`, section 2). Code: `server/fundingScreen.ts`. The result goes in the evidence result as `funding_screen` and never changes its status: `payer_independence_screen` is `clear`, `flagged` with the reasons, or `inconclusive` with what it could not see.

It reads, for the 30 days up to the charge's block:

- USDC transfers into the payer, and into each wallet that paid it (two hops), at most 50 per wallet;
- USDC transfers out of the payer, and for each that went to a Levy contract, the payouts that follow the payer's own pull in that transaction (another subscriber's charge in the same transaction is not counted). The largest is the merchant's; the other is Levy's fee;
- the payer's nonce and balance at the block where the window starts.

The transfers come from Arc's explorer (`ARC_TESTNET_EXPLORER_URL`, default `https://explorer.testnet.arc.io`, a Blockscout instance), because Arc's public RPC answers `eth_getLogs` over at most a few thousand blocks and 30 days is about five million. The explorer is a third party's index of the chain, not the chain, so a transfer it leaves out is a transfer the screen does not see; a `clear` result is never proof of independence. The explorer lists each USDC movement once under the ERC-20 address, whichever interface made it, a plain native send included, so nothing is counted twice. One screen makes at most 200 explorer requests, spaced to stay inside the explorer's rate limit; a payer with many funders can take a minute. The nonce and balance come from `ARC_TESTNET_RPC_URL` at a past block, which Arc's public RPC serves.

The screen is `inconclusive` when it could not see everything: a wallet with more than 50 transfers in the window, an explorer that has not finished indexing or does not list the charge yet, a charge transaction with more transfers than one page, USDC minted within two hops (bridged in, with its source untraced), or a read that failed (marked `read_failed`, with a fixed message so a repeated outage stores the same result). The explorer's answers are checked: each transfer must be for the wallet and direction asked, in order, and no later than the charge, and the block it names for the window's start must not be later than that time by the RPC's clock. On a re-run, a screen that could not finish reading and found nothing does not replace a complete one for the same charge, so an explorer outage does not change what reviewers signed for.

A settled payment releases on a plain approval only when its screen is `clear`; otherwise every approval has to waive it (`docs/two-person-review.md`). A merchant payment, for the "no other merchant payment" and "three merchants of one furnisher" flags, is a Levy charge: a payment made outside Levy is not recognised as one.

## The Arc/Levy adapter, bound

What a `verified` result from this adapter rests on, field by field. Anything outside it is never `verified`.

| Binding | How it is fixed |
| --- | --- |
| Chain | The event's `amount.chain` names a registry entry (`arc-testnet`), which fixes chain id 5042002; the RPC must report that id. The result records it as `charge.chain_id`. |
| Token | USDC's ERC-20 interface at `0x3600...0000`, 6 decimals, `amount.asset` `USDC`. Arc's 18-decimal native mirror of each transfer is never read. |
| Contract | A log from a SubscriptionManager listed in the registry. A Levy-shaped log from any other address is unverified (below). |
| Transaction | `evidence.tx_hash` in the signed event. |
| Log index | Exactly one charge log in the transaction matches the event's payer and amount; two or more go to review, never a guess. The result records its index, and the claim key (chain id, transaction, log index) ties one log to one line. The v1 event has no field for the index (its `evidence` object allows only `tx_hash`, `counteraudit_packet` and `log_ref`), so the index is bound by this rule and the claim, not by the furnisher's signature. |
| Recipient | The plan's merchant is one of the furnisher's vetted accounts on that chain, or the line goes to review and claims nothing. |
| Payer | The subscription's subscriber at that block is the event's `subject_ref.wallet`. |
| Amount | Exact, in base units; a failed charge's amount due is read at the block and the block before, and a difference between them goes to review. |
| Finality | The block is at or below the RPC's `finalized` block, and the RPC's block at that height has the receipt's hash. |
| Reorgs | None on Arc (below). A hash mismatch is retried, not decided. |
| Minimum | 1 USDC per charge (above). |
| Time and age | `occurred_at` within 24 hours of the block; the charge less than 24 months old. |

## Explicitly unverified

These have no verifier. Each comes back `needs_review` with a reason that names it, so a line on one can only be released by reviewers who waive the evidence, and a file then says `waived_by_reviewers`, never a `_verified` label.

- **Another chain or asset:** any `amount.chain` other than `arc-testnet` (Arc mainnet, Base, BNB, Robinhood, Solana) or any asset other than USDC: `no verifier for ...`.
- **Another settlement path:** a transaction that moved USDC with no log from a listed SubscriptionManager. That covers x402 transfers (the facilitator's `transferWithAuthorization`), escrow, batch and cross-chain settlement: `unverified settlement path: the transaction moves USDC with no Levy SubscriptionManager log`.
- **A Levy deployment not in the registry:** a retired SubscriptionManager, or a contract emitting Levy-shaped logs that is not Levy's: `unverified settlement path: ... not a listed SubscriptionManager`. Before 2026-11-01 these failed, contrary to this page; they now go to review as it said.
- **Outcomes with no machine check:** see "Not covered yet".

A transaction that moved no USDC and has no Levy log at all still fails: nothing in it can back a payment line.

## Finality and reorg policy

Arc uses Malachite BFT consensus: a committed block is final and there are no reorgs (Levy `VERIFICATION.md` section 3). The verifier still reads only at or below the `finalized` block, and compares the block hash at the receipt's height with the receipt's own. A mismatch means the RPC answered from inconsistent state (Arc's public RPC is load-balanced), so the check is retried, not decided. A chain added later with probabilistic finality needs its own confirmation depth and reorg handling before it gets a registry entry.

## Registry

The registry is code, so each change is a reviewed pull request.

- **Chains** (`CHAINS`): only `arc-testnet`. Arc mainnet (`arc`) is not listed because Levy is not deployed there.
- **Token:** USDC's ERC-20 interface at `0x3600000000000000000000000000000000000000`, 6 decimals, minimum 1 USDC per charge. Arc also logs an 18-decimal native copy of every USDC transfer from `0xfffffffffffffffffffffffffffffffffffffffe`; the verifier never reads it.
- **Levy:** the SubscriptionManager deployed 2026-10-24, `0xea24ac9c1217a671139d93225fdcf19ea3c4df4e`. Retired deployments are left out, so their charges go to review.
- **Furnisher accounts** (`FURNISHER_ACCOUNTS`): the merchant addresses each furnisher has shown it controls, per chain. A Levy line reports the furnisher's own billing, so the charge's merchant must be one of them. The list is empty: until a furnisher is vetted for Levy, its charges go to review. Adding one is part of vetting that furnisher.

## Reads, not writes

The verifier holds no key and sends no transaction. It makes six kinds of read: `eth_chainId`, the finalized block, a block by number, a transaction receipt, and two Levy view calls (`subscriptions`, `plans`) at the receipt's block and, for a failed charge, the block before. `ARC_TESTNET_RPC_URL` picks the endpoint; requests time out after 10 seconds and are retried once.

The endpoint is trusted. The chain id and block hash checks catch an inconsistent answer, not a dishonest endpoint, so the operator picks one they trust (a node of their own before mainnet).

## Tests

`server/evidence.test.ts` runs every check against three real Arc testnet transactions saved in `server/fixtures/arc-levy/charges.json`: a first charge at subscribe, a keeper renewal, and a failed charge. To run the same events against the live chain instead:

```sh
ARC_LIVE=1 pnpm vitest run server/evidence.test.ts
```

## Not covered yet

- `refunded`, `delivered`, `disputed`, `not_delivered`, `access_revoked` and `policy_violation`: no machine check. They need signed provider logs or a CounterAudit packet plus human review (Phase 0 item 3).
- Subjects named by a registry id or DID: matching them to a payer wallet is Phase 3 (decision 3).
- Evidence fields inside the signed event that pin the chain id and log index. Today the event names only the transaction and the chain, and the verifier finds the log (see the binding table). Pinning them in the signature needs a new event schema version, since v1's `evidence` allows no other fields.
- Wash payments between wallets that are not on the furnisher's account list. Testnet USDC is free, so a vetted furnisher could pay itself from a wallet it has not listed. Only review and furnisher vetting catch that.
