# The Agent Bureau

The source of [theagentbureau.xyz](https://theagentbureau.xyz): the BUREAU interrogation game and its agent API, and the Agent Bureau outcome service, which records signed reports from businesses about how AI agents' operators paid and delivered.

The Bureau's aim is one dated, evidence-backed file per agent operator, built mostly from outcomes that other businesses report and no public chain shows. It states facts with their sources and never a score or verdict. [`docs/bureau-spec.md`](docs/bureau-spec.md) has the full design.

## Status

- **Live:** the website and the BUREAU game, for people at [/play](https://theagentbureau.xyz/play) and for AI agents through the API described at [/agents](https://theagentbureau.xyz/agents).
- **Test data only:** the outcome service. Intake, proof checks, Arc testnet payment evidence, line states and two-person review are built and tested, but every intake run must be marked test data, and no live line is released. Outside data waits on the retention and legal review in [`docs/bureau-outcome-service-phase0.md`](docs/bureau-outcome-service-phase0.md).
- **Not built:** assembling and selling Bureau files, matching wallets and registrations to operators, and disputes from subjects.

## What is in this repository

| Path                          | What it holds                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client/`                     | The React site: home, the Bureau page, the game, agent docs, privacy and terms, and the private operator inbox.                                                                                                                |
| `client/public/`              | Files served as they are, including the agent API's [`openapi.json`](client/public/openapi.json), [`llms.txt`](client/public/llms.txt), a sample agent, and the outcome event JSON Schemas under `schemas/`.                   |
| `server/`                     | The Express and tRPC server. The game is in `game.ts`, `cases/`, `interrogate.ts` (suspects played by Claude) and `agentApi.ts`. The outcome service is in `furnishIntake.ts`, `evidence.ts`, `lineState.ts` and `review*.ts`. |
| `scripts/`                    | The operator commands `pnpm furnish:intake` and `pnpm review`, which the website does not expose, and the build's page renderer.                                                                                               |
| `drizzle/`                    | The MySQL schema and migrations. The server applies pending migrations each time it starts.                                                                                                                                    |
| `server/fixtures/`            | Recorded CounterAudit proofs and the shared outcome event v1 test vectors, pinned by SHA-256.                                                                                                                                  |
| `docs/`                       | The specification, decisions and operator guides listed below.                                                                                                                                                                 |
| `Dockerfile`, `DEPLOYMENT.md` | How to run the site in production.                                                                                                                                                                                             |

The game is fiction. No real agent, person or business appears in a case, and game results never go into a Bureau file.

## How an outcome becomes a line

1. A business (a furnisher) signs its outcome events with [agent-bureau-furnish](https://github.com/RunTimeAdmin/agent-bureau-furnish): Ed25519 over RFC 8785 canonical JSON, one event per line.
2. The operator runs `pnpm furnish:intake --test-data signed.jsonl`. Each event goes to the Bureau's [CounterAudit](https://counteraudit.io) organization, which checks the furnisher's registered key and seals the event in a hash chain with a public proof. The script checks that proof itself.
3. For `paid` and `payment_failed` events the script checks the payment on Arc testnet: the charge, its amount and both parties, in a final block, against the furnisher's vetted merchant account.
4. Each line gets a state (sealed, source signed, evidence verified, disputed, withdrawn, superseded or released) from the rules in [`docs/line-states.md`](docs/line-states.md).
5. A line is released only after review. Reviewers sign their decisions with their own keys, and a live line needs two of them to approve ([`docs/two-person-review.md`](docs/two-person-review.md)).

## Documents

| Document                                                                    | What it covers                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`bureau-spec.md`](docs/bureau-spec.md)                                     | What the Bureau is, what a file contains, furnishers, subscribers, privacy and legal |
| [`bureau-outcome-service-phase0.md`](docs/bureau-outcome-service-phase0.md) | The decisions recorded before building the outcome service, and what is still open   |
| [`furnisher-one-pager.md`](docs/furnisher-one-pager.md)                     | The pitch and pilot terms for a business that reports outcomes                       |
| [`counteraudit-intake.md`](docs/counteraudit-intake.md)                     | Operator guide to the intake script                                                  |
| [`evidence-verifier.md`](docs/evidence-verifier.md)                         | What the Arc testnet payment check proves, and what it does not                      |
| [`line-states.md`](docs/line-states.md)                                     | Line states, relations between lines, and how a line is displayed                    |
| [`two-person-review.md`](docs/two-person-review.md)                         | Signed review decisions and the release rule                                         |

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
