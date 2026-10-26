# Report agent outcomes to The Agent Bureau

**Pilot, late 2026. Draft for conversations with prospective furnishers.**

If your API, MCP server or marketplace deals with AI agents, you already know which ones pay, deliver and stay within your rules. The Agent Bureau pools those outcomes across businesses. Each of you can then check an agent's record with others before you serve it, bill it later or give it terms.

## What you get

- **Free Bureau files** during the pilot. After it, the proposal is one free file for every 10 outcomes you report each month.
- **Alerts** when an agent you reported on picks up a new negative outcome, dispute or slash somewhere else.
- **A shared record** that makes it harder for a bad operator to move from one of your peers to the next under a new name.

## What a file shows

Facts with dates and sources, never a score or a verdict:

- which registrations belong to the same operator across Arc, Base, BNB Chain, Robinhood Chain and Solana, and why we think so
- its public registry record
- payments it has made and received on-chain
- outcomes other businesses reported
- open and closed disputes
- what we could not see

You set your own thresholds.

## What you send

One line per outcome: `paid`, `payment_failed`, `delivered`, `not_delivered`, `disputed`, `refunded`, `access_revoked` or `policy_violation`.

Each line carries your own reference, the agent (registry id, wallet or DID), the time, an amount for payments, and evidence for negative outcomes (a transaction hash or a reference to your logs). Export a CSV from your system, sign it with our free, open-source tool, and send us the signed file. The signature proves the report came from you and hasn't been changed. The tool is [agent-bureau-furnish](https://github.com/RunTimeAdmin/agent-bureau-furnish) and runs with one `npx` command, nothing to install.

Not ready to sign yet? During the pilot you can send an unsigned CSV through the channel we agree when you join. We'll mark those reports "unsigned".

## What we commit to

- Your reports appear only inside Bureau files. We never sell them raw, and they never appear on public sites, including Nooscape.
- Subscribers see your category ("x402 API seller", "MCP server operator"), not your name, unless you choose to be named. The agent's owner sees who reported, so they can dispute.
- Every report is sealed in a tamper-evident log.
- You can stop at any time.

## What we ask of you

- Report every outcome of a type for the agents you report on, good and bad. Negatives alone distort the record.
- Back every negative outcome with evidence.
- Reply to a dispute about your report within 15 days.

## Pilot terms

- The pilot runs 90 days and is free for furnishers.
- These are draft terms, to be finalized after legal review. Nothing on this page is a contract.
- Agents' owners can see their own file, dispute any line, and add a statement. Every file pull is logged and visible to the owner.

## Get started

Brief us at [theagentbureau.xyz](https://theagentbureau.xyz/#contact) and choose "Partnership". We'll set up your furnisher id and register your signing key.

The event format, CSV columns and signing rules are in the [tool's README](https://github.com/RunTimeAdmin/agent-bureau-furnish#readme).
