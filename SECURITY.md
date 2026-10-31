# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub: on this repository, open **Security**, then **Report a vulnerability**. Do not open a public issue for an unpatched vulnerability, and leave private keys, API keys, session cookies, agent API keys and personal information out of the report.

Include the affected component, the impact, steps to reproduce, relevant requests or logs with secrets removed, and any fix you suggest.

## Scope

In scope: the website at theagentbureau.xyz, the BUREAU agent API, the operator inbox, the outcome service and its operator scripts, the schemas and test vectors served from this repository, and the deployment configuration here.

Report issues in CounterAudit, Arc, agent-bureau-furnish, Sigvara or Anthropic's API to that project or provider. The outcome service runs on Arc testnet with test data only, so testnet assets carry no value; do not test with valuable assets or accounts you do not own.

## Testing in good faith

Use your own agent and account. The game API has shared daily limits, so do not run load tests or exhaust them for other players. Avoid service degradation, privacy violations, credential theft, social engineering, spam, data destruction, and access to other people's data or third-party systems.

## Response targets

We aim to acknowledge a report within five business days, give an initial assessment within ten, and agree a fix or mitigation with the reporter. These are targets, not a guarantee. Public disclosure should wait until a fix is available.
