# Cross-organization intake

How the Bureau accepts an outcome a furnisher sealed in its own CounterAudit organization, instead of one the Bureau seals in its own. Phase 0 decision 6 chose this route: CounterAudit seals the whole signed event and serves a public proof anyone can check without an API key. This is the Bureau's side of it. Like every intake, it is limited to test data until the conditions in `docs/counteraudit-intake.md` are met.

```
Status:     built 2026-10-31, test data only
Decisions:  owner, 2026-10-31 (below)
Relates to: docs/counteraudit-intake.md, docs/bureau-outcome-service-phase0.md (decisions 5 and 6)
```

## Decisions

The owner settled three questions on 2026-10-31:

1. **The Bureau lists each furnisher's keys itself.** In a furnisher's own organization, the furnisher registered its key there, so CounterAudit's check says only that the event verifies with a key the furnisher chose. The Bureau needs its own word on whose key it is. `server/furnishers.ts` lists each furnisher's keys, changed only by reviewed pull request, as reviewer keys and merchant accounts are.
2. **Each furnisher is pinned to one CounterAudit organization**, listed with its keys. Its lines then come from one chain that can later be checked for gaps and edits, rather than from wherever a valid signature turns up.
3. **The packet must expire within the retention baseline.** A furnisher's organization keeps packets indefinitely unless it has a retention policy, and the baseline says CounterAudit must not (decision 5). So the proof must show `expires_at`, no later than 24 months after the Bureau receives the event.

## What the furnisher does

1. Create a CounterAudit organization, and give the Bureau its id.
2. Register its signing key there as an outcome signer (`POST /v1/admin/outcome-signers`), and give the Bureau the same public key, key id and furnisher id out of band.
3. Set a retention policy of 24 months or less (`PUT /v1/admin/retention`). Packets sealed before the policy was set carry no expiry date in their proof and are refused.
4. Seal each signed event with an ingest key of that organization: `POST /v1/audit/ingest` with `connector_id: "agent-bureau-outcome-v1"`, the signed event as `raw_event`, and `public_proof: true`. The receipt gives the `packet_id`.
5. Send the Bureau a JSONL file with one line per event: `{"packet_id": "<packet id>", "event": { ...the signed event... }}`.

## What the Bureau checks

For each line, `pnpm furnish:intake --test-data --sealed <file>`:

- reads the furnisher and key from the event, and refuses the line if `server/furnishers.ts` does not list that furnisher, or lists the key as revoked or not at all;
- fetches the packet's public proof from CounterAudit, without a key, and runs every check a line sealed in the Bureau's organization runs (`docs/counteraudit-intake.md`, Proof checks), with the organization pinned to the furnisher's;
- checks that the proof's signer key is the one the Bureau lists (`registered_key`);
- checks that the proof shows `expires_at`, still in the future and no later than 24 months after CounterAudit sealed the packet (`retention`). Both dates are in the signed proof.

A new line is stored only once its proof passes every check, since there is no sealed packet the Bureau can stand behind otherwise, and CounterAudit's signed proof is kept with it (in `receipt`) as its record of what was sealed, checkable offline after the packet is erased. From there it is the same line as any other: its evidence is checked, it shows as `unverified` until reviewers release it, and a later line from the same furnisher can withdraw, replace or dispute it.

A line the Bureau already holds is re-checked against CounterAudit's own proof checks only. The listing and retention checks decide whether a new line is stored, and do not undo one: a packet past its expiry by the time of a re-run, or a key revoked since, leaves the line as it was. A proof that names another organization than the one the line came from changes nothing, so a sealed file cannot touch a line the Bureau holds from its own organization.

The run seals nothing. It fetches each packet's public proof, without a key, and checks its signature against CounterAudit's export key as pinned in `server/counterauditKeys.ts`. It needs only `DATABASE_URL` (and `COUNTERAUDIT_API_URL` if not the default).

## Limits

- **Holds.** A legal hold set in the furnisher's own organization can keep a packet past `expires_at`, and the proof does not show holds.
- **One furnisher id, one party.** A furnisher listed here and a signer registered in the Bureau's own CounterAudit organization under the same `furnisher_id` act on each other's lines (withdrawals, replacements, charges). They must be the same business. A furnisher listed under the Bureau's own organization is refused.
- **Test furnishers only.** Until the retention conditions close (decision 5), list only test furnishers: one reviewer can release a test line.

## Adding a furnisher

A pull request to `server/furnishers.ts` with its `furnisher_id`, its CounterAudit organization id and each key (`key_id`, public key exactly as the furnish tool prints it, `active`). Confirm the organization id and the key with the furnisher over a channel other than the one the request arrived on. To retire a key, mark it `revoked`: its new events are refused, and lines already stored keep their checks.

## Not built yet

- A `seal` command in agent-bureau-furnish that seals events in the furnisher's organization and writes the sealed lines.
- Checking a furnisher's chain for gaps between the packets it sends (its signed checkpoints would allow it).
- Any intake of outside data: the test-data limit applies here as everywhere.
