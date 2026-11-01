# The Agent Bureau

The source of [theagentbureau.xyz](https://theagentbureau.xyz): the BUREAU interrogation game and its agent API, and the Agent Bureau outcome service, which records signed reports from businesses about how AI agents' operators paid and delivered.

The Bureau's aim is one dated, evidence-backed file per agent operator, built mostly from outcomes that other businesses report and no public chain shows. It states facts with their sources and never a score or verdict. [`docs/bureau-spec.md`](docs/bureau-spec.md) has the full design.

## Status

- **Live:** the website and the BUREAU game, for people at [/play](https://theagentbureau.xyz/play) and for AI agents through the API described at [/agents](https://theagentbureau.xyz/agents).
- **Test data only:** the outcome service. Intake, proof checks, Arc testnet payment evidence, the funding screen, line states, two-person review through an independent review log, and signed agent files (with Sigvara's standing as a third-party fact) are built and tested. Every intake run must be marked test data, and no live line is released: the review log's pinned genesis is a testnet one whose three reviewers the operator holds, so a decision on live data counts for nothing ([/review-log](https://theagentbureau.xyz/review-log) shows one run). Outside data waits on counsel's retention review ([`docs/bureau-outcome-service-phase0.md`](docs/bureau-outcome-service-phase0.md)) and on independent reviewers sealing their own genesis.
- **Not built:** serving and selling Bureau files to subscribers, matching wallets and registrations to operators, and disputes from subjects.

## What is in this repository

| Path                          | What it holds                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client/`                     | The React site: home, the Bureau page, the game, agent docs, privacy and terms, and the private operator inbox.                                                                                                                                                    |
| `client/public/`              | Files served as they are, including the agent API's [`openapi.json`](client/public/openapi.json), [`llms.txt`](client/public/llms.txt), a sample agent, and the outcome event JSON Schemas under `schemas/`.                                                       |
| `server/`                     | The Express and tRPC server. The game is in `game.ts`, `cases/`, `interrogate.ts` (suspects played by Claude) and `agentApi.ts`. The outcome service is in `furnishIntake.ts`, `evidence.ts`, `fundingScreen.ts`, `lineState.ts`, `review*.ts` and `agentFile.ts`. |
| `scripts/`                    | The operator commands `pnpm furnish:intake`, `pnpm review` and `pnpm file`, which the website does not expose, and the build's page renderer.                                                                                                                      |
| `drizzle/`                    | The MySQL schema and migrations. The server applies pending migrations each time it starts.                                                                                                                                                                        |
| `server/fixtures/`            | Recorded CounterAudit proofs and the shared outcome event v1 test vectors, pinned by SHA-256.                                                                                                                                                                      |
| `docs/`                       | The specification, decisions and operator guides listed below.                                                                                                                                                                                                     |
| `Dockerfile`, `DEPLOYMENT.md` | How to run the site in production.                                                                                                                                                                                                                                 |

The game is fiction. No real agent, person or business appears in a case, and game results never go into a Bureau file.

## How an outcome becomes a line

1. A business (a furnisher) signs its outcome events with [agent-bureau-furnish](https://github.com/RunTimeAdmin/agent-bureau-furnish): Ed25519 over RFC 8785 canonical JSON, one event per line.
2. The operator runs `pnpm furnish:intake --test-data signed.jsonl`. Each event goes to the Bureau's [CounterAudit](https://counteraudit.io) organization, which checks the furnisher's registered key and seals the event in a hash chain with a public proof. The script checks that proof itself.
3. For `paid` and `payment_failed` events the script checks the payment on Arc testnet: the charge, its amount and both parties, in a final block, against the furnisher's vetted merchant account.
4. Each line gets a state (sealed, source signed, evidence verified, disputed, withdrawn, superseded or released) from the rules in [`docs/line-states.md`](docs/line-states.md).
5. A line is released only after review. Reviewers sign their decisions with their own keys, and a live line needs two of them to approve ([`docs/two-person-review.md`](docs/two-person-review.md)).
6. `pnpm file assemble` puts a subject's released lines on a signed file, each pointing at its CounterAudit packet's public proof, and `pnpm file verify` checks one ([`docs/agent-file.md`](docs/agent-file.md)).

## Documents

| Document                                                                    | What it covers                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`bureau-spec.md`](docs/bureau-spec.md)                                     | What the Bureau is, what a file contains, furnishers, subscribers, privacy and legal |
| [`bureau-outcome-service-phase0.md`](docs/bureau-outcome-service-phase0.md) | The decisions recorded before building the outcome service, and what is still open   |
| [`furnisher-one-pager.md`](docs/furnisher-one-pager.md)                     | The pitch and pilot terms for a business that reports outcomes                       |
| [`counteraudit-intake.md`](docs/counteraudit-intake.md)                     | Operator guide to the intake script                                                  |
| [`cross-org-intake.md`](docs/cross-org-intake.md)                           | Taking packets a furnisher sealed in its own CounterAudit organization               |
| [`evidence-verifier.md`](docs/evidence-verifier.md)                         | What the Arc testnet payment check proves, and what it does not                      |
| [`independent-payer.md`](docs/independent-payer.md)                         | What a settled payment proves, and the funding screen for a related payer            |
| [`line-states.md`](docs/line-states.md)                                     | Line states, relations between lines, and how a line is displayed                    |
| [`two-person-review.md`](docs/two-person-review.md)                         | Signed review decisions and the release rule                                         |
| [`review-log-design.md`](docs/review-log-design.md)                         | The independent review log in CounterAudit and its rules for reviewer keys           |
| [`agent-file.md`](docs/agent-file.md)                                       | What an agent's file holds, how it is signed, and how a reader checks it             |

## Run it locally

You need Node.js 22, pnpm 10.34.9 and, for anything that stores data, a MySQL-compatible database.

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env   # then fill in the values you need
pnpm dev
```

The game needs `ANTHROPIC_API_KEY`, and the operator inbox needs `OPERATOR_PASSWORD` and `SESSION_SECRET`. [`DEPLOYMENT.md`](DEPLOYMENT.md) lists every variable.

Typecheck and run the tests (no database needed):

```sh
pnpm check
pnpm test
```

`ARC_LIVE=1 pnpm test server/evidence.test.ts` also reads real transactions from Arc testnet.

## Related projects

- [agent-bureau-furnish](https://github.com/RunTimeAdmin/agent-bureau-furnish): the signing tool for furnishers, and the home of the shared test vectors that this repository and CounterAudit both check.
- [Sigvara](https://github.com/RunTimeAdmin/Sigvara): reputation and bonds for agents over ERC-8004 on Arc testnet.
- [CounterAudit](https://counteraudit.io): sealed, hash-chained, timestamped event ingest, used here as the system of record for furnished events.

## Security

Please report vulnerabilities privately, as described in [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE)
