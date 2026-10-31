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

The intake adds one check the chain cannot answer: no other stored line already claims the same settlement log (`evidenceKey`: chain id, transaction and log index). A line claims a charge only when its CounterAudit proof passed and the charge's merchant is that furnisher's vetted account. Every Levy charge is public, so this keeps another furnisher from claiming a charge first to push the real line into review. A second line claiming the same charge goes to review. A stored claim is never cleared by a later check, so a later result cannot free the charge for another line.

## Results

| Status         | Meaning                                                                                                                                                                                                                                                                                                               | Next                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `verified`     | Every check passed.                                                                                                                                                                                                                                                                                                   | Still shown `unverified` |
| `failed`       | The chain contradicts the event: wrong amount, payer, merchant or time; reverted transaction; no matching Levy log.                                                                                                                                                                                                   | Kept, with reasons       |
| `needs_review` | No machine check applies: another outcome, chain or asset; no transaction hash; a subject that is not an EVM wallet; a furnisher with no vetted account; several matching charges; too many charge logs; a merchant paying itself; an amount due that changed within the block; a charge another line already claims. | A person reviews it      |
| `pending`      | The transaction is not found yet, or its block is not finalized yet. A load-balanced RPC node can lag, so not found is not a verdict.                                                                                                                                                                                 | Run the intake again     |
| `error`        | The chain could not be read, or the RPC was inconsistent (wrong chain, block hash mismatch).                                                                                                                                                                                                                          | Run the intake again     |

Every result keeps its reasons and, when a charge was found, what the chain showed: chain, transaction, log index, block number, hash and time, contract, token, subscription, payer, recipient and amount.

A `verified` result does not change how a line is shown. Showing a line as `verified` needs a passing proof, a `verified` evidence result, and (Phase 0 decision 4) the review states and two-person review, which also come before any negative line affects anyone. Those are the next build items. Until then every line stays `unverified`, and intake stays test-data only.

On a re-run the intake records a new evidence result only when the event is the one the line stores (same signed-event hash) and the check reached a verdict. A `pending` or `error` result never replaces an earlier one.

## Finality and reorg policy

Arc uses Malachite BFT consensus: a committed block is final and there are no reorgs (Levy `VERIFICATION.md` section 3). The verifier still reads only at or below the `finalized` block, and compares the block hash at the receipt's height with the receipt's own. A mismatch means the RPC answered from inconsistent state (Arc's public RPC is load-balanced), so the check is retried, not decided. A chain added later with probabilistic finality needs its own confirmation depth and reorg handling before it gets a registry entry.

## Registry

The registry is code, so each change is a reviewed pull request.

- **Chains** (`CHAINS`): only `arc-testnet`. Arc mainnet (`arc`) is not listed because Levy is not deployed there.
- **Token:** USDC's ERC-20 interface at `0x3600000000000000000000000000000000000000`, 6 decimals. Arc also logs an 18-decimal native copy of every USDC transfer from `0xfffffffffffffffffffffffffffffffffffffffe`; the verifier never reads it.
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
- Evidence fields inside the signed event that pin the chain id and log index. Today the event names only the transaction, and the verifier finds the log.
- The review queue itself, review states and two-person review.
- Wash payments between wallets that are not on the furnisher's account list. Testnet USDC is free, so a vetted furnisher could pay itself from a wallet it has not listed. Only review and furnisher vetting catch that.
- Two intake runs at once: the claim check and the insert are not one transaction, and `evidenceKey` is not unique. Intake is run by one operator, one file at a time.
