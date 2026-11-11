# Key custody

Who holds each key and secret the Bureau uses, where it may live, and what to do when one is lost or may have leaked. No private key or secret goes in this repository, the site's archive, a log, a chat or an AI tool's session.

## What there is

| What                     | Held by                                  | Public half pinned in                                                            | Lets its holder                                                                                                                              |
| ------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| File key (Ed25519)       | The operator                             | `server/bureauFileKeys.ts`, served at `/.well-known/agent-bureau-file-keys.json` | Sign agents' files (`docs/agent-file.md`)                                                                                                    |
| Reviewer keys (Ed25519)  | Each reviewer, their own                 | The review log, from the genesis pinned in `server/reviewLog.ts`                 | Decide on lines, admit furnishers, vote on reviewer changes and approve key changes in the review organization (`docs/two-person-review.md`) |
| Furnisher keys (Ed25519) | Each furnisher. The Bureau holds none    | CounterAudit, and `server/furnishers.ts` for a furnisher in its own organization | Sign that furnisher's outcome events                                                                                                         |
| CounterAudit API keys    | The operator, the site and each reviewer | Bearer keys, nothing to pin                                                      | Seal or read in one organization. An admin key also issues keys and registers signers                                                        |
| Site secrets             | The hosting account's settings           | None                                                                             | Run the site and sign in to `/inbox`                                                                                                         |

CounterAudit's seal and export keys are CounterAudit's to hold, under its own custody guide. The Bureau pins only the export keys' public halves (`server/counterauditKeys.ts`).

## The file key

A file's signature says the Bureau issued it. `pnpm file assemble` reads the private key from a file when it signs. The site never reads it: only the public half ships with the site.

### Where it lives

Today the one key, `bureau-file-2026-11`, signs test files only (`LIVE_FILES_HELD`, `docs/agent-file.md`). A key that signs live files must meet all of these:

- **One holder.** The operator, with no second copy and no shared account.
- **An encrypted disk, on a machine that serves nothing to the public.** The tools cannot read an encrypted key, so the disk is its only protection at rest.
- **Readable only by the account that signs.** `pnpm file keygen` writes it that way (mode 600, where the file system has permissions) and refuses to overwrite a file.
- **Given to a signing run by path.** Its contents never go in an environment variable, on a command line or into a paste.
- **No backup.** A lost key costs a new key and a pull request, since verifying needs only the public half and every file it signed still checks. A backup is one more copy to steal. If the machine's disk is backed up or snapshotted, keep the key on a volume left out of that.

Until serving is built the Bureau keeps no record of the files it signs: `pnpm file assemble` writes each to the path it is given. So the operator keeps a private list of each `file_id`, its subject and who received it. Withdrawing a key (below) has nothing to work from without it.

### Replacing a key

Once a year, when the holder or the machine changes, and before live files:

1. Run `pnpm file keygen <private-key-file>` where the new key will live.
2. List its public key under a new key id in `server/bureauFileKeys.ts`, by pull request. Merge and deploy, and update the signing machine's checkout: `pnpm file assemble` signs only with a key pinned there.
3. Sign with the new key. A reader with a saved key list rejects these files until they update.
4. Destroy the old private key.
5. Leave the old public key pinned while files it signed may be checked. Unpinning makes all of them fail, and a line whose source CounterAudit has erased rests on that signature alone.

If the disk died, the key is gone: do the same without step 4. If the machine went missing, treat the key as stolen.

### Withdrawing a stolen key

Do this when the key was stolen or may have been. Whoever holds it can sign a file the Bureau never issued, with any date, because a key has no validity window. The line checks still catch a line CounterAudit never sealed, but a line's subject, data class and release rest on the Bureau's signature alone (`docs/agent-file.md`), so none of that can be trusted on a file signed with that key.

So the key is withdrawn, not retired. Files it honestly signed then fail too, with "signed with a key that is not pinned". That is the better failure: a file can be signed again, but a forged one cannot be told from a real one.

1. Stop signing with it.
2. Make a new key on a machine the leak cannot have reached.
3. In one pull request, remove the old key from `server/bureauFileKeys.ts`, add the new one, and add the old key to the list below. Merge and deploy the same day, and update the signing machine's checkout. `pnpm file verify` at that commit stops accepting the old key at once, and the site's key list within five minutes of the deploy.
4. Tell every reader on the private list. A reader on an older checkout or with a saved key list accepts the old key until they update, and nothing reaches them by itself.
5. Assemble a new file for each subject a reader still needs. It shows the lines as they stand now, not as the old file did.
6. Destroy every copy of the old private key you can reach, and find out how it got out before the new key goes near that machine. If the machine itself was reached, treat every other secret on it as leaked too.

**Withdrawn file keys:** none.

## Reviewer keys

`docs/two-person-review.md` has the commands.

- **Where they live.** Each reviewer makes their own with `pnpm review keygen`, on their own machine, and keeps it on an encrypted disk. It never goes to the Bureau or into this repository.
- **May have leaked.** Any one reviewer suspends it at once, and every line on which it holds a current decision is held. Two reviewers then rotate it.
- **Lost.** Two reviewers rotate it.
- **After a rotation** every decision signed with the old key stops counting, and the reviewer signs again what should stand. A file that named those decisions fails `pnpm file verify --current`, so assemble a new one. Furnisher admissions stand: they count by the key held when they were sealed.
- **Two keys stolen.** Two of three keys are the authority in the review log, so its own rules cannot recover from this. Stop file runs and tell every reader on the private list: a file still passes a `pnpm file verify` that has no review key, since that run does not read the log. The reviewers then make new keys and seal a new genesis in a new review organization, a pull request pins both, and `pnpm review move` takes the Bureau's copy there (`docs/two-person-review.md`, Moving to a new review organization). Decisions in the old log stop counting and furnisher admissions start over. The old organization stays governed by the stolen keys in CounterAudit, though the Bureau no longer reads it.

The pinned genesis is a testnet one today: the operator holds all three keys, so the two-person guarantee does not hold and only test data can be released (`docs/two-person-review.md`, Testnet).

## Furnisher keys

The Bureau holds none and never asks for one (`docs/bureau-outcome-service-phase0.md`, decision 3). When a furnisher's key may have leaked, the furnisher stops using it and tells the operator:

- In the Bureau's organization, the operator revokes the signer in CounterAudit (`DELETE /v1/admin/outcome-signers/:id`). That stops new events.
- For a furnisher in its own organization, a pull request marks the key `revoked` in `server/furnishers.ts`. That stops new events and keeps every live line it signed from being released, whatever its date. Those lines' proofs still check.

One reviewer can also end the furnisher's admission at once (`revoke-admission`), which holds all its live lines until two reviewers admit it again, and any reviewer can reject a line signed since the leak. A replacement key needs a new pair of admissions, and the probation starts again (`docs/two-person-review.md`).

## CounterAudit API keys

| Variable                         | Role and organization                                    | Used by                                                                                                                                     | Kept                                   |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `COUNTERAUDIT_READ_KEY`          | read, the Bureau's                                       | The site's hourly `pnpm dispute sync`. The operator's `pnpm file`, `pnpm furnish:intake`, `pnpm lines seal-evidence` and `pnpm review head` | Site settings and the operator's runs  |
| `COUNTERAUDIT_INGEST_KEY`        | ingest, the Bureau's                                     | `pnpm furnish:intake`, `pnpm dispute submit`, `pnpm lines seal-evidence`                                                                    | The operator's runs only               |
| `COUNTERAUDIT_REVIEW_READ_KEY`   | read, the review organization's                          | The Bureau's own for `pnpm review sync` and `pnpm file`. Each reviewer's own for `pnpm review head`                                         | The operator's runs, and each reviewer |
| `COUNTERAUDIT_REVIEW_INGEST_KEY` | ingest, the review organization's                        | `pnpm review submit`                                                                                                                        | Each reviewer, their own               |
| None                             | admin, each organization, with CounterAudit's admin TOTP | Issuing and revoking keys, registering and revoking signers                                                                                 | Never on the site or in a run          |

The site's scheduled jobs (`server/schedules.ts`) need no ingest key, so it stays out of the site's settings.

To replace one, issue a new key in CounterAudit with an expiry, put it where the old one was, and revoke the old one (`DELETE /v1/admin/keys/:id`). If it may have leaked, revoke first and accept that the job using it fails until the new one is in. In the review organization, once its genesis has taken effect, these requests need reviewers' approvals (`docs/two-person-review.md`).

## Site secrets

These live in the hosting account's settings and nowhere in the site's archive.

| Secret                                | To replace it                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `OPERATOR_PASSWORD`, `SESSION_SECRET` | Change it and restart. Everyone is signed out (`DEPLOYMENT.md`).                                          |
| `DATABASE_URL`                        | Change the database password in the hosting account, then in the site's settings and the operator's copy. |
| `ANTHROPIC_API_KEY`                   | Revoke it with Anthropic and set a new one. It runs the game and nothing else.                            |

`/inbox` holds contact messages and can hide agents from the scoreboard. Lines, reviews and files are not reachable from it. Game agents' API keys are stored only as hashes, so a database leak gives none of them away.

## Pins

What the Bureau's code trusts is in this repository: `server/bureauFileKeys.ts`, `server/reviewLog.ts`, `server/furnishers.ts` and `server/counterauditKeys.ts`. Each changes by pull request, which leaves a public record anyone can watch. So merge access decides what the Bureau trusts and the hosting account decides what the site serves, and both are part of custody. Keep a second factor on each.

Head pins (`COUNTERAUDIT_MIN_HEAD`, `COUNTERAUDIT_REVIEW_MIN_HEAD`) are kept where `pnpm file verify --current` runs, outside CounterAudit's database and backups.

## Before live files

`LIVE_FILES_HELD` goes to false only by a pull request that cites counsel's review (`docs/agent-file.md`). Before that pull request:

- [ ] A new file key that meets the list above, pinned in the pull request that unpins `bureau-file-2026-11`, which has signed only test files.
- [ ] Replacing and withdrawing a key rehearsed once on test data.
- [ ] Independent reviewers hold their own keys, `REVIEW_GENESIS` and `REVIEW_ORG_ID` name their genesis and organization, `pnpm review move` has taken the Bureau's copy there, and the testnet keys are destroyed.
- [ ] A change to a pinned file needs an approver other than its author.
- [ ] `/inbox` has a second factor or sits behind a stronger sign-in (`DEPLOYMENT.md`).
- [ ] The operator's private list of signed files is in use.
- [ ] An outside security audit of the release tag and the deployed configuration, including the evidence readers' contracts and chain settings as they are deployed (review of 11 November).
- [ ] A written way for an outside verifier to get, keep, refresh and compare its own head pins for `pnpm file verify --current`, and readers told that a plain `pnpm file verify` checks signatures and proofs, not current standing.
- [ ] A test that a dispute sealed after a file was issued changes what `pnpm file verify --current` reports.

## Limits

- **No validity window.** A pinned key can sign a file dated in the past (`docs/agent-file.md`), which is why a stolen key is withdrawn and not retired.
- **No passphrase, HSM or KMS.** The tools read a plain PEM file, so none of these can protect a key today.
- **A withdrawal reaches a reader only when they update.** Nothing pushes it to them.
- **Nothing detects a theft.** The Bureau's code cannot see a read of a key file. A file nobody issued is the only sign.
