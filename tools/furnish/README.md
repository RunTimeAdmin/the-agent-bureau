# furnish

Signs and verifies Agent Bureau outcome events (v0). The rules are in
[`docs/bureau-spec.md`](../../docs/bureau-spec.md). The machine-readable
format is [`client/public/schemas/outcome-event-v0.json`](../../client/public/schemas/outcome-event-v0.json),
generated from [`event.ts`](event.ts).

## Commands

```sh
pnpm furnish keygen acme.key
pnpm furnish sign --key acme.key --furnisher fur_acme01 --out signed.jsonl events.csv
pnpm furnish verify --public-key ed25519:... signed.jsonl
pnpm furnish schema
```

- `keygen` writes an Ed25519 private key (PKCS#8 PEM) and prints the public key to register with the Bureau. It never overwrites a file. `*.key` is gitignored.
- `sign` checks every event first and writes nothing if any fails, listing each problem by line. Input is CSV or a JSON array; `schema_version` and `furnisher_id` are filled in for you. Output is one signed event per line.
- `verify` checks format, signature and duplicate `event_id`s. It exits non-zero if anything fails.
- `schema` regenerates the JSON Schema after a change to `event.ts`. A test fails until you do.

## CSV columns

| Column | Required | Notes |
| --- | --- | --- |
| `event_id` | yes | Your own reference, unique per furnisher: letters, digits, `. _ : -` |
| `outcome` | yes | `paid`, `refunded`, `payment_failed`, `delivered`, `not_delivered`, `disputed`, `access_revoked`, `policy_violation` |
| `occurred_at` | yes | UTC, e.g. `2026-10-20T14:03:00Z` |
| `subject_chain`, `subject_registry`, `subject_id` | one subject | Chain is `arc`, `base`, `bnb`, `robinhood` or `solana` |
| `subject_wallet` | one subject | EVM or Solana address |
| `subject_did` | one subject | e.g. `did:countersig:...` |
| `amount_value`, `amount_asset`, `amount_chain` | `paid`, `refunded`, `payment_failed` | Value as a decimal string: `12.50` |
| `evidence_tx_hash`, `evidence_counteraudit_packet`, `evidence_log_ref` | at least one for `payment_failed`, `not_delivered`, `access_revoked`, `policy_violation` | |

Fill exactly one subject per row. Unknown columns are rejected, so a typo can't silently drop data.

## Signature

The signature is Ed25519 over `agent-bureau/outcome-event/v0\n` followed by the event without its `signature` field, in RFC 8785 canonical JSON (keys sorted, no whitespace). The prefix stops a furnisher key's other signatures from being replayed as events. Keys and signatures are written as `ed25519:` plus base64url.
