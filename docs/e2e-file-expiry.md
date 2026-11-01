# End-to-end test: a line expires with its CounterAudit source

`scripts/e2e/file-expiry.ts` runs the path in [When a line's source expires](agent-file.md#when-a-lines-source-expires) with real code on both sides: a CounterAudit server started from a CounterAudit checkout, against a throwaway Postgres, and the Bureau's own intake, review log, `pnpm file` and `pnpm lines` code, against a throwaway MySQL. It prints PASS or FAIL for each check, exits 0 only when every check passes, and removes the containers and files it made.

## What it proves

1. **CounterAudit seals the event with a retention date.** A furnisher's organization takes a retention policy of one month (the shortest CounterAudit allows) and registers the furnisher's signing key, and the furnisher's signed outcome event is sealed there with a public proof. It is sent with `received_at` as early as CounterAudit takes it, and the proof's `expires_at` is one month after that.
2. **The Bureau stores and releases the line, and signs a file.** `pnpm furnish:intake --test-data --sealed` stores the line, its proof verified. Three reviewers seal a genesis and two of them approve the line in a review organization on the same server (`pnpm review key`, `sign` and `submit`), and `pnpm review sync` shows it released. `pnpm file assemble` signs a file whose line carries `checkable_until` equal to the proof's `expires_at`, with the disclosure for it, and `pnpm file verify` passes it ("proof verified", exit 0).
3. **CounterAudit erases the packet.** `node scripts/retention-expiry.js` erases nothing before `expires_at`. Once it has passed (see below), CounterAudit's retention job erases the packet, and `GET /v1/proofs/{packet_id}` answers 410 with a tombstone signed with the export key.
4. **Verify reports the line expired.** `pnpm file verify` on the same file reports the line as expired ("CounterAudit erased its source") and exits 0. Given a copy of the tombstone with its `expired_at` moved by a second, it reports "erasure record FAILED" and exits 1. `pnpm file assemble` now leaves the line off and names it.
5. **The Bureau erases its copy.** `pnpm lines expire --dry-run` names the line and changes nothing. `pnpm lines expire` sets the row's `subjectRef` and `signedEvent` to null and `expiredAt` to the time, and a fresh `pnpm file assemble` for the subject signs a file without the line.

## What is real and what is not

Every step runs the two repositories' own code: CounterAudit's routes, sealing, retention job and proofs, and the Bureau's `runIntake`, `runReview`, `runFile` and `runLines`, the functions behind the `pnpm` commands, in the test's process. Four things differ from production, and the run prints a NOTE for each.

- **Pins.** The Bureau pins CounterAudit's production export key (`server/counterauditKeys.ts`), its own file keys (`server/bureauFileKeys.ts`) and its furnishers (`server/furnishers.ts`). `runFile` and `runLines` take these from their io object, which here carries the local server's export key, a file key made for the run and the test's furnisher. The intake takes no keys from its caller, so the local export key is added to the pinned list in memory while the intake runs, and taken out after.
- **The review genesis.** The review log counts only the genesis pinned in `server/reviewLog.ts`, whose reviewers' keys the operator holds. The test makes three reviewer keys, and a loader hook (`scripts/e2e/review-genesis-pin.mjs`) replaces the pinned hash with their genesis hash as that module loads, in the test's process only. The pinned genesis is the testnet one, so the log still counts as testnet, and only test-data decisions count, as now. The decisions themselves are real: signed with `pnpm review sign`, sealed with `pnpm review submit`, and read back by `pnpm review sync`, `pnpm file assemble` and `pnpm file verify`.
- **When the packet expires.** CounterAudit's shortest policy is one month, and it counts from `received_at` only when that is at most 30 days before the seal. So the earliest `expires_at` is one calendar month after the date 30 days before the seal. When that date falls in a month of 31 days, as for any run in November, that is a day after the seal; in a shorter month, as for most runs in December, it can be minutes after it. When it is within 15 minutes, the test waits for it and runs `node scripts/retention-expiry.js` again. Otherwise it runs what that script runs, `runExpiry` from `src/services/erasureService.js`, with its `now` option set to one second past `expires_at`. Neither changes CounterAudit's code or a database row. In the second case CounterAudit dates the erasure at the real time, before the file's `checkable_until`, and verify says so. The waiting branch has not run yet: the run below was on 1 November.
- **Local servers.** Postgres and MySQL run in Docker with their data in memory. CounterAudit runs with `NODE_ENV=development`, a fresh export key and seal key, and none of the shell's `CA_`, `COUNTERAUDIT_`, database or Redis settings. Its organizations are made with `POST /v1/auth/signup`, on the dev plan.

## Running it

It needs:

- Docker, with the `postgres:16-alpine` and `mysql:8` images (pulled on first use), and ports 5442, 3317 and 3858 free on 127.0.0.1.
- This repository with its dependencies installed (`pnpm install`).
- A CounterAudit checkout with its dependencies installed (`npm ci`), named by `COUNTERAUDIT_CHECKOUT`. It must have no `.env` file, since the server would load it; a worktree of `origin/main` is the simplest.

```bash
COUNTERAUDIT_CHECKOUT=/path/to/counteraudit pnpm exec tsx scripts/e2e/file-expiry.ts
```

A run takes about two minutes, one of them spent waiting for CounterAudit's 60-second proof cache to let go of the erased packet's proof. On a failure the test keeps its working directory (keys, files and the CounterAudit server's log) and prints where it is.

## A run

1 November 2026, Bureau 8db56e2 and CounterAudit 87986ce. Lines marked `|` are what the commands under test printed.

```
== Setup
Run at 2026-11-01T18:43:57.451Z
Bureau 8db56e2, CounterAudit 87986ce (COUNTERAUDIT_CHECKOUT)
Postgres (e2e-ca-pg, port 5442) and MySQL (e2e-bureau-mysql, port 3317) are up.
CounterAudit is up at http://127.0.0.1:3858, signing with export key e2e-local-export-1.
The Bureau's migrations are applied.
NOTE the review log counts only the genesis pinned in server/reviewLog.ts, whose reviewers' keys the operator holds. This run seals its own reviewers' genesis in a local review organization, and a loader hook (scripts/e2e/review-genesis-pin.mjs) puts its hash 3c4a31154d99... in place of the pin in this process (REVIEW_GENESIS, and TESTNET_GENESIS while it is the same: testnet true). The decisions themselves are real: signed, sealed and read back.

== 1. CounterAudit: a furnisher's organization with a retention policy seals a signed outcome event
PASS 1a the furnisher's organization is created (POST /v1/auth/signup)
PASS 1b its retention policy is 1 month, the shortest CounterAudit allows (PUT /v1/admin/retention)
PASS 1c the furnisher's signing key fur_e2e959ed680/e2e-key-1 is registered there (POST /v1/admin/outcome-signers)
PASS 1d the furnisher has an ingest key (POST /v1/admin/keys, role ingest)
NOTE CounterAudit's shortest policy is 1 month, counted from received_at when that is at most 30 days before the seal. For a packet sealed at 2026-11-01T18:44:22.438Z the earliest expires_at is 2026-11-02T18:45:22.438Z (received_at 2026-10-02T18:45:22.438Z), 24 h 1 min ahead.
PASS 1e the signed event is sealed with a public proof and received_at (POST /v1/audit/ingest): packet 5c2b1033-a0eb-4b09-b148-eb91ca948393
PASS 1f its public proof says expires_at 2026-11-02T18:45:22.438Z, 24 h 1 min after the seal at 2026-11-01T18:44:22.476Z

== 2. The Bureau stores the line, reviewers release it, and pnpm file assemble signs a file verify accepts
NOTE the furnisher is listed for this run in the io's furnishers (organization 59ca3930-8bbc-4632-a506-65c7c54a9e14), not in server/furnishers.ts.
NOTE the intake checks proofs against the export keys pinned in server/counterauditKeys.ts and takes none from its caller, so the local server's export key is added to that list in memory for the intake's run only, and taken out after it.
    | Test-data intake of packets sealed in furnishers' own CounterAudit organizations, proofs from http://127.0.0.1:3858
    | line 1: fur_e2e959ed680/e2e-1793558662438: packet 5c2b1033-a0eb-4b09-b148-eb91ca948393 (furnisher's listed organization 59ca3930-8bbc-4632-a506-65c7c54a9e14), proof verified, stored as unverified test data, evidence needs review: no machine check exists for delivered outcomes
    | Summary: 1 line.
    | CounterAudit: 0 sealed, 0 already sealed, 0 refused, 0 conflicts, 0 failed, 0 not sent.
    | Proofs: 1 verified, 0 failed, 0 not checked.
    | Evidence: 0 verified, 1 to review, 0 failed, 0 not checked yet.
    | Bureau: 1 stored, 0 already stored, 0 not stored.
PASS 2a pnpm furnish:intake --test-data --sealed stores the line, its proof verified
PASS 2b a review organization with an ingest key for each reviewer and a read key for the Bureau
    | Signed and written to genesis-rev_e2ea.json. Seal it with: pnpm review submit genesis-rev_e2ea.json
    | {"schema":"agent-bureau/reviewer-key/v1","signer_id":"rev_e2ea","change":{"type":"genesis","reviewers":[{"reviewer_id":"rev_e2ea","name":"E2E reviewer A","public_key":"ed25519:8wBlaVpb_N5SoJFh3EXN3YNYkb-Wtg7epMOoMp4b1fQ"},{"reviewer_id":"rev_e2eb","name":"E2E reviewer B","public_key":"ed25519:tZOmmgKJDTqrX8b9gYkFa1Myp0lB_75-mnCm1UOel3w"},{"reviewer_id":"rev_e2ec","name":"E2E reviewer C","public_key":"ed25519:lkLdlfxPRiR2Mvjxp6uY6KottvAhNqsPVpWTSbGEzBA"}]},"decided_at":"2026-11-01T18:44:22.606Z","signature":"ed25519:r9NK-ns0XuWhD84zQBmMYUOgRyA2wQOaMaRYhtNwagJUNnOQv0JawXGgFSWS_KY9j5ZZB4F8P1KXp42fiEiWCA"}
    | Genesis hash: 3c4a31154d99ab5f0f7b1a83402f6c59e0e18b0227f9dc8f3ce18f6f15518f6f. Every reviewer it names should see the same. The Bureau counts this genesis only once REVIEW_GENESIS in server/reviewLog.ts is set to it, by pull request.
    | Sealed in the review log: packet 58d7785b-6fba-4109-87b5-6c399b971059, sequence 0. Once the operator syncs, pnpm review queue lists it there.
    | Receipt written to genesis-rev_e2ea.json.receipt.json. Keep it.
    | Signed and written to genesis-rev_e2eb.json. Seal it with: pnpm review submit genesis-rev_e2eb.json
    | {"schema":"agent-bureau/reviewer-key/v1","signer_id":"rev_e2eb","change":{"type":"genesis","reviewers":[{"reviewer_id":"rev_e2ea","name":"E2E reviewer A","public_key":"ed25519:8wBlaVpb_N5SoJFh3EXN3YNYkb-Wtg7epMOoMp4b1fQ"},{"reviewer_id":"rev_e2eb","name":"E2E reviewer B","public_key":"ed25519:tZOmmgKJDTqrX8b9gYkFa1Myp0lB_75-mnCm1UOel3w"},{"reviewer_id":"rev_e2ec","name":"E2E reviewer C","public_key":"ed25519:lkLdlfxPRiR2Mvjxp6uY6KottvAhNqsPVpWTSbGEzBA"}]},"decided_at":"2026-11-01T18:44:22.678Z","signature":"ed25519:siuCcwTKxDbrYrzReL0oiUUjWlbREKbLjX3aBthi_t3yn7gdynKx2nXRhSczB3WI8rVykq8t88WEfQVO1SS0AA"}
    | Genesis hash: 3c4a31154d99ab5f0f7b1a83402f6c59e0e18b0227f9dc8f3ce18f6f15518f6f. Every reviewer it names should see the same. The Bureau counts this genesis only once REVIEW_GENESIS in server/reviewLog.ts is set to it, by pull request.
    | Sealed in the review log: packet 9b4f58e7-3f1d-46c7-9003-32836e816230, sequence 1. Once the operator syncs, pnpm review queue lists it there.
    | Receipt written to genesis-rev_e2eb.json.receipt.json. Keep it.
    | Signed and written to genesis-rev_e2ec.json. Seal it with: pnpm review submit genesis-rev_e2ec.json
    | {"schema":"agent-bureau/reviewer-key/v1","signer_id":"rev_e2ec","change":{"type":"genesis","reviewers":[{"reviewer_id":"rev_e2ea","name":"E2E reviewer A","public_key":"ed25519:8wBlaVpb_N5SoJFh3EXN3YNYkb-Wtg7epMOoMp4b1fQ"},{"reviewer_id":"rev_e2eb","name":"E2E reviewer B","public_key":"ed25519:tZOmmgKJDTqrX8b9gYkFa1Myp0lB_75-mnCm1UOel3w"},{"reviewer_id":"rev_e2ec","name":"E2E reviewer C","public_key":"ed25519:lkLdlfxPRiR2Mvjxp6uY6KottvAhNqsPVpWTSbGEzBA"}]},"decided_at":"2026-11-01T18:44:22.708Z","signature":"ed25519:WywrzXeO1OPjTxQjj50fbMnBB6egzgh5NAjIRGaI-BazhByihMEQTwT-_miAqQgvrBTUPfkZVQZgnbCca8bKAQ"}
    | Genesis hash: 3c4a31154d99ab5f0f7b1a83402f6c59e0e18b0227f9dc8f3ce18f6f15518f6f. Every reviewer it names should see the same. The Bureau counts this genesis only once REVIEW_GENESIS in server/reviewLog.ts is set to it, by pull request.
    | Sealed in the review log: packet 4b3c3f30-9a08-44e7-a907-969597196056, sequence 2. Once the operator syncs, pnpm review queue lists it there.
    | Receipt written to genesis-rev_e2ec.json.receipt.json. Keep it.
PASS 2c the three reviewers sign and seal their genesis (pnpm review key --genesis, pnpm review submit)
    | Signed and written to decision-rev_e2ea.json. Seal it with: pnpm review submit decision-rev_e2ea.json
    | {"schema":"agent-bureau/review-decision/v1","reviewer_id":"rev_e2ea","furnisher_id":"fur_e2e959ed680","event_id":"e2e-1793558662438","signed_event_hash":"826d9790ef05b2907481a765153d1d80dc4c0e985566db7e4338885cbb4eb474","data_class":"test","evidence_digest":"08e2e4ffa98a83a3dcd11f7193150403c7d6b39fe964958fd7f0b0aa641f7faa","decision":"approve_with_waiver","reason":"e2e test: no machine check exists for delivered outcomes","decided_at":"2026-11-01T18:44:22.738Z","signature":"ed25519:nFjQkqXoJ4E-AjfGpdCi3qE2JNHRDP2LA8X-NXKmUOt2M4JYpSw3DCA5Vmkz5yKy1Qc5p21_7jYblbUp2pL1Ag"}
    | Sealed in the review log: packet 05bdaf59-55c3-48ff-a84b-64ac31f7e87b, sequence 3. Once the operator syncs, pnpm review queue lists it there.
    | Receipt written to decision-rev_e2ea.json.receipt.json. Keep it.
    | Signed and written to decision-rev_e2eb.json. Seal it with: pnpm review submit decision-rev_e2eb.json
    | {"schema":"agent-bureau/review-decision/v1","reviewer_id":"rev_e2eb","furnisher_id":"fur_e2e959ed680","event_id":"e2e-1793558662438","signed_event_hash":"826d9790ef05b2907481a765153d1d80dc4c0e985566db7e4338885cbb4eb474","data_class":"test","evidence_digest":"08e2e4ffa98a83a3dcd11f7193150403c7d6b39fe964958fd7f0b0aa641f7faa","decision":"approve_with_waiver","reason":"e2e test: no machine check exists for delivered outcomes","decided_at":"2026-11-01T18:44:22.765Z","signature":"ed25519:TqhWZJLbsaaYzxu5L_cZljW-ZdlxOiisjDTZzuf-vAAEyQ7QMcOICqz7O7ZsWf1qwfqSZU1HczEd1wEddaTXBA"}
    | Sealed in the review log: packet c675b6f0-e8c9-4718-87bb-4231d32c20d6, sequence 4. Once the operator syncs, pnpm review queue lists it there.
    | Receipt written to decision-rev_e2eb.json.receipt.json. Keep it.
    | Read 5 new packets.
    |   sequence 0: rev_e2ea signed the genesis of rev_e2ea, rev_e2eb, rev_e2ec
    |   sequence 1: rev_e2eb signed the genesis of rev_e2ea, rev_e2eb, rev_e2ec
    |   sequence 2: genesis of rev_e2ea, rev_e2eb, rev_e2ec took effect, signed by all of them
    | Review log read to sequence 4.
    | Reviewers: rev_e2ea (E2E reviewer A) active, rev_e2eb (E2E reviewer B) active, rev_e2ec (E2E reviewer C) active.
    | These are the operator-held testnet reviewers: only decisions on test data count, and no live line is released.
    | fur_e2e959ed680/e2e-1793558662438: unverified -> released
    | 1 line settled, 1 changed.
PASS 2d two reviewers approve the line (pnpm review sign, pnpm review submit), and pnpm review sync shows it released
    | Wrote the private key to bureau-file.key, readable only by you.
    | Public key: ed25519:2uaP7WCkOjInlMtoIH9FDpDfQ1kYEBDh29Sd7piRSWg
    | Pin it in server/bureauFileKeys.ts under a new key id, by pull request, before signing with it.
NOTE the io for pnpm file and pnpm lines carries the local server's export key (e2e-local-export-1) in place of server/counterauditKeys.ts, and this run's file key pinned as e2e-file-1 in place of server/bureauFileKeys.ts.
    | File 32661e5d-b267-44e3-8bc7-bb33d6f5bca7 for {"did":"did:example:e2e-959ed680"}: 1 line standing and 0 in history, signed with e2e-file-1, written to file.json.
    | The review log has only the operator-held testnet reviewers, so only test-data lines can be on a file, and the file says so.
PASS 2e pnpm file assemble signs a file whose line has checkable_until 2026-11-02T18:45:22.438Z, the proof's expires_at, with the disclosure for it
    | Bureau signature: verified
    | About: {"did":"did:example:e2e-959ed680"}
    | File 32661e5d-b267-44e3-8bc7-bb33d6f5bca7, issued 2026-11-01T18:44:22.891Z, reviewers operator_held_testnet
    | Review log: assembled at sequence 4 (packet c675b6f0-e8c9-4718-87bb-4231d32c20d6)
    | 5c2b1033-a0eb-4b09-b148-eb91ca948393: proof verified (delivered, sealed in 59ca3930-8bbc-4632-a506-65c7c54a9e14)
    | Review log: position and 2 decision(s) verified against the review organization
PASS 2f pnpm file verify: exit 0, proof verified

== 3. CounterAudit's retention job erases the packet; its proof URL answers 410 with a signed tombstone
    | exit 0: erased 0, refused 0, needs_attention false, ran_at 2026-11-01T18:44:23.343Z
PASS 3a node scripts/retention-expiry.js --org <furnisher org>, run before expires_at, erases nothing
NOTE APPROXIMATION: expires_at is 24 h 1 min away, too long to wait, and CounterAudit gives no earlier date honestly: its shortest policy is 1 month and received_at may be at most 30 days before the seal, so on this date a packet expires 24 h 1 min after its seal at the earliest. Instead of waiting, the test runs what scripts/retention-expiry.js runs, runExpiry from src/services/erasureService.js, with its now option set to 2026-11-02T18:45:23.438Z, 1 s past expires_at. No CounterAudit code or database row is changed.
    | exit 0: erased 1, refused 0, needs_attention false, ran_at 2026-11-02T18:45:23.438Z
PASS 3b runExpiry({ orgId, now: 2026-11-02T18:45:23.438Z }), as the script runs it, erases the packet
PASS 3c GET /v1/proofs/5c2b1033-a0eb-4b09-b148-eb91ca948393 answers 410 with a tombstone the export key signed, erased at 2026-11-01T18:44:24.408Z (the server answered 200 from its proof cache for 57 s after the erasure)

== 4. pnpm file verify reports the line expired; a tampered tombstone fails
    | Bureau signature: verified
    | About: {"did":"did:example:e2e-959ed680"}
    | File 32661e5d-b267-44e3-8bc7-bb33d6f5bca7, issued 2026-11-01T18:44:22.891Z, reviewers operator_held_testnet
    | Review log: assembled at sequence 4 (packet c675b6f0-e8c9-4718-87bb-4231d32c20d6)
    | 5c2b1033-a0eb-4b09-b148-eb91ca948393: expired: CounterAudit erased its source at 2026-11-01T18:44:24.408Z, before the file's checkable_until (2026-11-02T18:45:22.438Z); the line rests on the Bureau's signature alone
    | Review log: position and 2 decision(s) verified against the review organization
PASS 4a pnpm file verify on the same file: the line is expired, CounterAudit erased its source, exit 0
    | Bureau signature: verified
    | About: {"did":"did:example:e2e-959ed680"}
    | File 32661e5d-b267-44e3-8bc7-bb33d6f5bca7, issued 2026-11-01T18:44:22.891Z, reviewers operator_held_testnet
    | Review log: assembled at sequence 4 (packet c675b6f0-e8c9-4718-87bb-4231d32c20d6)
    | 5c2b1033-a0eb-4b09-b148-eb91ca948393: erasure record FAILED: tombstone_signature: digest_mismatch (key e2e-local-export-1)
    | Review log: position and 2 decision(s) verified against the review organization
PASS 4b the same verify, served a tombstone whose expired_at was moved by a second: erasure record FAILED, exit 1
    | Left off, its source has expired: 5c2b1033-a0eb-4b09-b148-eb91ca948393: CounterAudit erased it at 2026-11-01T18:44:24.408Z
    | File 2dd986b8-1b2c-47d6-b2b4-99f48937269d for {"did":"did:example:e2e-959ed680"}: 0 lines standing and 0 in history, signed with e2e-file-1, written to file-before-lines-expire.json.
    | No released line names exactly this subject. Matching is exact apart from EVM addresses in a wallet or a did:sigvara, so check the spelling.
    | The review log has only the operator-held testnet reviewers, so only test-data lines can be on a file, and the file says so.
PASS 4c pnpm file assemble, before the Bureau erases its copy, leaves the line off and names it

== 5. pnpm lines expire erases the Bureau's copy; a fresh file leaves the line off
    | fur_e2e959ed680/e2e-1793558662438 (packet 5c2b1033-a0eb-4b09-b148-eb91ca948393): would be erased: CounterAudit erased it at 2026-11-01T18:44:24.408Z
    | 1 line checked (0 expired before): 1 would be erased, 0 held, 0 not checked.
PASS 5a pnpm lines expire --dry-run names the line and changes nothing
    | fur_e2e959ed680/e2e-1793558662438 (packet 5c2b1033-a0eb-4b09-b148-eb91ca948393): erased: CounterAudit erased it at 2026-11-01T18:44:24.408Z
    | 1 line checked (0 expired before): 1 erased, 0 held, 0 not checked.
PASS 5b pnpm lines expire erases it: subjectRef and signedEvent null, expiredAt 2026-11-01T18:45:22.853Z
    | File fe4da1b1-09db-4864-a1bb-cd492798a7fa for {"did":"did:example:e2e-959ed680"}: 0 lines standing and 0 in history, signed with e2e-file-1, written to file-after-lines-expire.json.
    | No released line names exactly this subject. Matching is exact apart from EVM addresses in a wallet or a did:sigvara, so check the spelling.
    | The review log has only the operator-held testnet reviewers, so only test-data lines can be on a file, and the file says so.
PASS 5c a fresh pnpm file assemble for the same subject signs a file without the line, exit 0

== Teardown
Stopped the CounterAudit server.
Removed the containers e2e-ca-pg and e2e-bureau-mysql, if they were there.

All 21 checks passed.
```
