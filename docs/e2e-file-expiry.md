# End-to-end test: a line expires with its CounterAudit source

`scripts/e2e/file-expiry.ts` runs the path in [When a line's source expires](agent-file.md#when-a-lines-source-expires) with real code on both sides: a CounterAudit server started from a CounterAudit checkout, against a throwaway Postgres, and the Bureau's own intake, review log, `pnpm file` and `pnpm lines` code, against a throwaway MySQL. It prints PASS or FAIL for each check, exits 0 only when every check passes, and removes the containers and files it made.

## What it proves

1. **CounterAudit seals the event with a retention date.** A furnisher's organization takes a retention policy of one month (the shortest CounterAudit allows) and registers the furnisher's signing key, and the furnisher's signed outcome event is sealed there with a public proof. It is sent with `received_at` as early as CounterAudit takes it, and the proof's `expires_at` is one month after that.
2. **The Bureau stores and releases the line, and signs a file.** The Bureau's own organization is made too, with an ingest key and a read key. `pnpm furnish:intake --test-data --sealed` stores the line, its proof verified, and seals its evidence result there (`agent-bureau-evidence-v1`, `docs/agent-file.md`, "Evidence seals"). Three reviewers seal a genesis and two of them approve the line in a review organization on the same server (`pnpm review key`, `sign` and `submit`), and `pnpm review sync` shows it released. `pnpm file assemble` signs a file whose line carries `checkable_until` equal to the proof's `expires_at`, with the disclosure for it, and `pnpm file verify` passes it ("proof verified", exit 0).
3. **CounterAudit erases the packet.** `node scripts/retention-expiry.js` erases nothing before `expires_at`. Once it has passed (see below), CounterAudit's retention job erases the packet, and `GET /v1/proofs/{packet_id}` answers 410 with a tombstone signed with the export key.
4. **Verify reports the line expired.** `pnpm file verify` on the same file reports the line as expired ("CounterAudit erased its source") and exits 0. Given a copy of the tombstone with its `expired_at` moved by a second, it reports "erasure record FAILED" and exits 1. `pnpm file assemble` now leaves the line off and names it.
5. **The Bureau erases its copy.** `pnpm lines expire --dry-run` names the line and changes nothing. `pnpm lines expire` sets the row's `subjectRef` and `signedEvent` to null and `expiredAt` to the time, and a fresh `pnpm file assemble` for the subject signs a file without the line.

## What is real and what is not

Every step runs the two repositories' own code: CounterAudit's routes, sealing, retention job and proofs, and the Bureau's `runIntake`, `runReview`, `runFile` and `runLines`, the functions behind the `pnpm` commands, in the test's process. Four things differ from production, and the run prints a NOTE for each.

- **Pins.** The Bureau pins CounterAudit's production export key (`server/counterauditKeys.ts`), its own file keys (`server/bureauFileKeys.ts`) and its furnishers (`server/furnishers.ts`). `runFile` and `runLines` take these from their io object, which here carries the local server's export key, a file key made for the run and the test's furnisher. The intake takes no keys from its caller, and `pnpm review sync` and file assembly check signed heads against the pinned list too, so the local export key is added to that list in memory for the rest of the run.
- **The review genesis.** The review log counts only the genesis pinned in `server/reviewLog.ts`, whose reviewers' keys the operator holds. The test makes three reviewer keys, and a loader hook (`scripts/e2e/review-genesis-pin.mjs`) replaces the pinned hash with their genesis hash as that module loads, in the test's process only. The pinned genesis is the testnet one, so the log still counts as testnet, and only test-data decisions count, as now. The decisions themselves are real: signed with `pnpm review sign`, sealed with `pnpm review submit`, and read back by `pnpm review sync`, `pnpm file assemble` and `pnpm file verify`. The hook pins the test's review organization the same way, so the test makes that organization before it loads the Bureau's modules.
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

2 November 2026, Bureau 9e94e92 and CounterAudit 9f4922a. Lines marked `|` are what the commands under test printed.

```
== Setup
Run at 2026-11-02T14:04:49.074Z
Bureau 9e94e92, CounterAudit 9f4922a (COUNTERAUDIT_CHECKOUT)
Postgres (e2e-ca-pg, port 5442) and MySQL (e2e-bureau-mysql, port 3317) are up.
CounterAudit is up at http://127.0.0.1:3858, signing with export key e2e-local-export-1.
The Bureau's migrations are applied.
NOTE the review log counts only the genesis pinned in server/reviewLog.ts, whose reviewers' keys the operator holds. This run seals its own reviewers' genesis in a local review organization, and a loader hook (scripts/e2e/review-genesis-pin.mjs) puts its hash 19668f83ecc6... in place of the pin in this process (REVIEW_GENESIS, and TESTNET_GENESIS while it is the same: testnet true). The decisions themselves are real: signed, sealed and read back.

== 1. CounterAudit: a furnisher's organization with a retention policy seals a signed outcome event
PASS 1a the furnisher's organization is created (POST /v1/auth/signup)
PASS 1b its retention policy is 1 month, the shortest CounterAudit allows (PUT /v1/admin/retention)
PASS 1c the furnisher's signing key fur_e2e5afe43ce/e2e-key-1 is registered there (POST /v1/admin/outcome-signers)
PASS 1d the furnisher has an ingest key (POST /v1/admin/keys, role ingest)
NOTE CounterAudit's shortest policy is 1 month, counted from received_at when that is at most 30 days before the seal. For a packet sealed at 2026-11-02T14:05:32.443Z the earliest expires_at is 2026-11-03T14:06:32.443Z (received_at 2026-10-03T14:06:32.443Z), 24 h 1 min ahead.
PASS 1e the signed event is sealed with a public proof and received_at (POST /v1/audit/ingest): packet e1024267-3fcb-4197-a10a-52c7a42a8a6e
PASS 1f its public proof says expires_at 2026-11-03T14:06:32.443Z, 24 h 1 min after the seal at 2026-11-02T14:05:32.479Z
PASS 1g the Bureau's own organization, with an ingest key to seal evidence results and a read key to read them

== 2. The Bureau stores the line, reviewers release it, and pnpm file assemble signs a file verify accepts
NOTE the furnisher is listed for this run in the io's furnishers (organization 44b09b17-cd76-47d3-addc-b138d6f57156), not in server/furnishers.ts.
NOTE the intake checks proofs against the export keys pinned in server/counterauditKeys.ts and takes none from its caller, so the local server's export key is added to that list in memory for the intake's run only, and taken out after it.
    | Test-data intake of packets sealed in furnishers' own CounterAudit organizations, proofs from http://127.0.0.1:3858
    | line 1: fur_e2e5afe43ce/3c2f7657-4a21-4d54-9142-a173095c9525: packet e1024267-3fcb-4197-a10a-52c7a42a8a6e (furnisher's listed organization 44b09b17-cd76-47d3-addc-b138d6f57156), proof verified, stored as unverified test data, evidence needs review: no machine check exists for delivered outcomes, evidence sealed as packet 99d2aea2-e095-4056-9791-c753330dca17
    | Summary: 1 line.
    | CounterAudit: 0 sealed, 0 already sealed, 0 refused, 0 conflicts, 0 failed, 0 not sent.
    | Proofs: 1 verified, 0 failed, 0 not checked.
    | Evidence: 0 verified, 1 to review, 0 failed, 0 not checked yet.
    | Bureau: 1 stored, 0 already stored, 0 not stored.
PASS 2a pnpm furnish:intake --test-data --sealed stores the line, its proof verified, and seals its evidence result in the Bureau's organization
PASS 2b a review organization with an ingest key for each reviewer and a read key for the Bureau
    | Signed and written to genesis-rev_e2ea.json. Seal it with: pnpm review submit genesis-rev_e2ea.json
    | {"schema":"agent-bureau/reviewer-key/v1","signer_id":"rev_e2ea","change":{"type":"genesis","reviewers":[{"reviewer_id":"rev_e2ea","name":"E2E reviewer A","public_key":"ed25519:J_it0bjwFxo6GNqj7VOv5kcRXktcs0y84ir45rPJ9Y4"},{"reviewer_id":"rev_e2eb","name":"E2E reviewer B","public_key":"ed25519:L-FOya-QFFsV8hEmWs973AFEjf_RnchL6QE6RCsea4M"},{"reviewer_id":"rev_e2ec","name":"E2E reviewer C","public_key":"ed25519:4SvL5x4lConNmLaGM6JN7reTS-HI-fcGPFiv2e_eRn8"}]},"decided_at":"2026-11-02T14:05:32.684Z","signature":"ed25519:n9gPv-x4LQcWSVN3T0uOGRYuSYGGYBGb_bBFTkaiPXHsU3i6Fk92WmQRnDDeHYr1ziXs4oFJekvoeHa3huacAw"}
    | Genesis hash: 19668f83ecc6fccb4064dec4bf912b21ce971171b65de0948af0536c5f8f5d1c. Every reviewer it names should see the same. The Bureau counts this genesis only once REVIEW_GENESIS in server/reviewLog.ts is set to it, by pull request.
    | Sealed in the review log: packet 96d4f5d1-631f-4abd-9712-82d6ba1f75bf, sequence 0. Once the operator syncs, pnpm review queue lists it there.
    | Receipt written to genesis-rev_e2ea.json.receipt.json. Keep it.
    | Signed and written to genesis-rev_e2eb.json. Seal it with: pnpm review submit genesis-rev_e2eb.json
    | {"schema":"agent-bureau/reviewer-key/v1","signer_id":"rev_e2eb","change":{"type":"genesis","reviewers":[{"reviewer_id":"rev_e2ea","name":"E2E reviewer A","public_key":"ed25519:J_it0bjwFxo6GNqj7VOv5kcRXktcs0y84ir45rPJ9Y4"},{"reviewer_id":"rev_e2eb","name":"E2E reviewer B","public_key":"ed25519:L-FOya-QFFsV8hEmWs973AFEjf_RnchL6QE6RCsea4M"},{"reviewer_id":"rev_e2ec","name":"E2E reviewer C","public_key":"ed25519:4SvL5x4lConNmLaGM6JN7reTS-HI-fcGPFiv2e_eRn8"}]},"decided_at":"2026-11-02T14:05:32.720Z","signature":"ed25519:ZUlwZH2gSQJYPYR4msUNZzZaf-y2UybudKfzrND96zx-sF6-FB7Kc38-FV7pSsEUN0mWr3MroOP8N8vs2uVRBA"}
    | Genesis hash: 19668f83ecc6fccb4064dec4bf912b21ce971171b65de0948af0536c5f8f5d1c. Every reviewer it names should see the same. The Bureau counts this genesis only once REVIEW_GENESIS in server/reviewLog.ts is set to it, by pull request.
    | Sealed in the review log: packet 0e91562e-840d-418e-a580-19711eb774b2, sequence 1. Once the operator syncs, pnpm review queue lists it there.
    | Receipt written to genesis-rev_e2eb.json.receipt.json. Keep it.
    | Signed and written to genesis-rev_e2ec.json. Seal it with: pnpm review submit genesis-rev_e2ec.json
    | {"schema":"agent-bureau/reviewer-key/v1","signer_id":"rev_e2ec","change":{"type":"genesis","reviewers":[{"reviewer_id":"rev_e2ea","name":"E2E reviewer A","public_key":"ed25519:J_it0bjwFxo6GNqj7VOv5kcRXktcs0y84ir45rPJ9Y4"},{"reviewer_id":"rev_e2eb","name":"E2E reviewer B","public_key":"ed25519:L-FOya-QFFsV8hEmWs973AFEjf_RnchL6QE6RCsea4M"},{"reviewer_id":"rev_e2ec","name":"E2E reviewer C","public_key":"ed25519:4SvL5x4lConNmLaGM6JN7reTS-HI-fcGPFiv2e_eRn8"}]},"decided_at":"2026-11-02T14:05:32.748Z","signature":"ed25519:fIovlFt03PRmKeruJZ0ga-RX9IlaqNz2CUoWgLsyWTQwO-xiNLrqz1s95-UNSh0Fv8-qkSbKyy82s68zdag9DQ"}
    | Genesis hash: 19668f83ecc6fccb4064dec4bf912b21ce971171b65de0948af0536c5f8f5d1c. Every reviewer it names should see the same. The Bureau counts this genesis only once REVIEW_GENESIS in server/reviewLog.ts is set to it, by pull request.
    | Sealed in the review log: packet af047943-3625-480d-aeaa-85194106b358, sequence 2. Once the operator syncs, pnpm review queue lists it there.
    | Receipt written to genesis-rev_e2ec.json.receipt.json. Keep it.
PASS 2c the three reviewers sign and seal their genesis (pnpm review key --genesis, pnpm review submit)
    | Signed and written to decision-rev_e2ea.json. Seal it with: pnpm review submit decision-rev_e2ea.json
    | {"schema":"agent-bureau/review-decision/v1","reviewer_id":"rev_e2ea","furnisher_id":"fur_e2e5afe43ce","event_id":"3c2f7657-4a21-4d54-9142-a173095c9525","signed_event_hash":"a852c2993548f15c2e9f0fccc5352eb0c73e00c5114694804b0af23a28eb26b1","data_class":"test","evidence_digest":"08e2e4ffa98a83a3dcd11f7193150403c7d6b39fe964958fd7f0b0aa641f7faa","decision":"approve_with_waiver","reason":"e2e test: no machine check exists for delivered outcomes","decided_at":"2026-11-02T14:05:32.781Z","signature":"ed25519:9LDTTVzUuZ7YmU9YOXF9HrKjsOlHcmAoPUNiID1edOXNxqkYDoxn98B-8IgYgrhnCEasljeASf-osOKiTFlBBw"}
    | Sealed in the review log: packet ff6fedac-a36a-4961-bd3e-702fc97127e2, sequence 3. Once the operator syncs, pnpm review queue lists it there.
    | Receipt written to decision-rev_e2ea.json.receipt.json. Keep it.
    | Signed and written to decision-rev_e2eb.json. Seal it with: pnpm review submit decision-rev_e2eb.json
    | {"schema":"agent-bureau/review-decision/v1","reviewer_id":"rev_e2eb","furnisher_id":"fur_e2e5afe43ce","event_id":"3c2f7657-4a21-4d54-9142-a173095c9525","signed_event_hash":"a852c2993548f15c2e9f0fccc5352eb0c73e00c5114694804b0af23a28eb26b1","data_class":"test","evidence_digest":"08e2e4ffa98a83a3dcd11f7193150403c7d6b39fe964958fd7f0b0aa641f7faa","decision":"approve_with_waiver","reason":"e2e test: no machine check exists for delivered outcomes","decided_at":"2026-11-02T14:05:32.810Z","signature":"ed25519:Dqhw6AuPtr3eSTqXl7MufM4BnKRAKxofy7Hsx9TxQvyiTcx-JmhEpdxD0yGyHfpiDDRhCSneoAQO0yw_BCW_Aw"}
    | Sealed in the review log: packet ad24f687-2b39-4edf-a836-39127ca7a214, sequence 4. Once the operator syncs, pnpm review queue lists it there.
    | Receipt written to decision-rev_e2eb.json.receipt.json. Keep it.
    | Read 5 new packets.
    |   sequence 0: rev_e2ea signed the genesis of rev_e2ea, rev_e2eb, rev_e2ec
    |   sequence 1: rev_e2eb signed the genesis of rev_e2ea, rev_e2eb, rev_e2ec
    |   sequence 2: genesis of rev_e2ea, rev_e2eb, rev_e2ec took effect, signed by all of them
    | Review log read to sequence 4.
    | Reviewers: rev_e2ea (E2E reviewer A) active, rev_e2eb (E2E reviewer B) active, rev_e2ec (E2E reviewer C) active.
    | These are the operator-held testnet reviewers: only decisions on test data count, and no live line is released.
    | fur_e2e5afe43ce/3c2f7657-4a21-4d54-9142-a173095c9525: unverified -> released
    | 1 line settled, 1 changed.
PASS 2d two reviewers approve the line (pnpm review sign, pnpm review submit), and pnpm review sync shows it released
    | Wrote the private key to bureau-file.key, readable only by you.
    | Public key: ed25519:1LGRt_MwuAcu8zZoO90riBmYn-V7z8cvUw9rgtmwDjc
    | Pin it in server/bureauFileKeys.ts under a new key id, by pull request, before signing with it.
NOTE the io for pnpm file and pnpm lines carries the local server's export key (e2e-local-export-1) in place of server/counterauditKeys.ts, and this run's file key pinned as e2e-file-1 in place of server/bureauFileKeys.ts.
    | File f8a180f4-92c8-4289-9864-10d645805ea7 for {"did":"did:example:e2e-5afe43ce"}: 1 line standing and 0 in history, signed with e2e-file-1, written to file.json.
    | The review log has only the operator-held testnet reviewers, so only test-data lines can be on a file, and the file says so.
PASS 2e pnpm file assemble signs a file whose line has checkable_until 2026-11-03T14:06:32.443Z, the proof's expires_at, with the disclosure for it, and names its evidence seal (packet 99d2aea2-e095-4056-9791-c753330dca17)
    | Bureau signature: verified
    | About: {"did":"did:example:e2e-5afe43ce"}
    | File f8a180f4-92c8-4289-9864-10d645805ea7, issued 2026-11-02T14:05:32.956Z, reviewers operator_held_testnet
    | Review log: assembled at sequence 4 (packet ad24f687-2b39-4edf-a836-39127ca7a214)
    | Review status: as assembled. This does not say the file still stands; pnpm file verify --current checks it against the review log as it is now.
    | e1024267-3fcb-4197-a10a-52c7a42a8a6e: proof verified (delivered, sealed in 44b09b17-cd76-47d3-addc-b138d6f57156)
    | Review log: position and 2 decision(s) verified against the review organization
PASS 2f pnpm file verify: exit 0, proof verified

== 3. CounterAudit's retention job erases the packet; its proof URL answers 410 with a signed tombstone
    | exit 0: erased 0, refused 0, needs_attention false, ran_at 2026-11-02T14:05:33.388Z
PASS 3a node scripts/retention-expiry.js --org <furnisher org>, run before expires_at, erases nothing
NOTE APPROXIMATION: expires_at is 24 h 1 min away, too long to wait, and CounterAudit gives no earlier date honestly: its shortest policy is 1 month and received_at may be at most 30 days before the seal, so on this date a packet expires 24 h 1 min after its seal at the earliest. Instead of waiting, the test runs what scripts/retention-expiry.js runs, runExpiry from src/services/erasureService.js, with its now option set to 2026-11-03T14:06:33.443Z, 1 s past expires_at. No CounterAudit code or database row is changed.
    | exit 0: erased 1, refused 0, needs_attention false, ran_at 2026-11-03T14:06:33.443Z
PASS 3b runExpiry({ orgId, now: 2026-11-03T14:06:33.443Z }), as the script runs it, erases the packet
PASS 3c GET /v1/proofs/e1024267-3fcb-4197-a10a-52c7a42a8a6e answers 410 with a tombstone the export key signed, erased at 2026-11-02T14:05:33.933Z (the server answered 200 from its proof cache for 60 s after the erasure)

== 4. pnpm file verify reports the line expired; a tampered tombstone fails
    | Bureau signature: verified
    | About: {"did":"did:example:e2e-5afe43ce"}
    | File f8a180f4-92c8-4289-9864-10d645805ea7, issued 2026-11-02T14:05:32.956Z, reviewers operator_held_testnet
    | Review log: assembled at sequence 4 (packet ad24f687-2b39-4edf-a836-39127ca7a214)
    | Review status: as assembled. This does not say the file still stands; pnpm file verify --current checks it against the review log as it is now.
    | e1024267-3fcb-4197-a10a-52c7a42a8a6e: expired: CounterAudit erased its source at 2026-11-02T14:05:33.933Z, before the file's checkable_until (2026-11-03T14:06:32.443Z); the line rests on the Bureau's signature alone
    | Review log: position and 2 decision(s) verified against the review organization
PASS 4a pnpm file verify on the same file: the line is expired, CounterAudit erased its source, exit 0
    | Bureau signature: verified
    | About: {"did":"did:example:e2e-5afe43ce"}
    | File f8a180f4-92c8-4289-9864-10d645805ea7, issued 2026-11-02T14:05:32.956Z, reviewers operator_held_testnet
    | Review log: assembled at sequence 4 (packet ad24f687-2b39-4edf-a836-39127ca7a214)
    | Review status: as assembled. This does not say the file still stands; pnpm file verify --current checks it against the review log as it is now.
    | e1024267-3fcb-4197-a10a-52c7a42a8a6e: erasure record FAILED: tombstone_signature: digest_mismatch (key e2e-local-export-1)
    | Review log: position and 2 decision(s) verified against the review organization
PASS 4b the same verify, served a tombstone whose expired_at was moved by a second: erasure record FAILED, exit 1
    | Left off, its source has expired: e1024267-3fcb-4197-a10a-52c7a42a8a6e: CounterAudit erased it at 2026-11-02T14:05:33.933Z
    | File 3d25c908-a470-4b28-b06f-a52619eb0ae5 for {"did":"did:example:e2e-5afe43ce"}: 0 lines standing and 0 in history, signed with e2e-file-1, written to file-before-lines-expire.json.
    | No line is on the file: 1 released line naming this subject was left off because its source has expired.
    | The review log has only the operator-held testnet reviewers, so only test-data lines can be on a file, and the file says so.
PASS 4c pnpm file assemble, before the Bureau erases its copy, leaves the line off and names it

== 5. pnpm lines expire erases the Bureau's copy; a fresh file leaves the line off
    | fur_e2e5afe43ce/3c2f7657-4a21-4d54-9142-a173095c9525 (packet e1024267-3fcb-4197-a10a-52c7a42a8a6e): would be erased: CounterAudit erased it at 2026-11-02T14:05:33.933Z
    | 1 line checked (0 expired before): 1 would be erased, 0 held, 0 not checked.
PASS 5a pnpm lines expire --dry-run names the line and changes nothing
    | fur_e2e5afe43ce/3c2f7657-4a21-4d54-9142-a173095c9525 (packet e1024267-3fcb-4197-a10a-52c7a42a8a6e): erased: CounterAudit erased it at 2026-11-02T14:05:33.933Z
    | 1 line checked (0 expired before): 1 erased, 0 held, 0 not checked.
PASS 5b pnpm lines expire erases it: subjectRef and signedEvent null, expiredAt 2026-11-02T14:06:35.149Z
    | File b9833d9f-1082-40b5-8c69-b0ccdf580fb9 for {"did":"did:example:e2e-5afe43ce"}: 0 lines standing and 0 in history, signed with e2e-file-1, written to file-after-lines-expire.json.
    | No released line names exactly this subject. Matching is exact apart from EVM addresses in a wallet or a did:sigvara, so check the spelling.
    | The review log has only the operator-held testnet reviewers, so only test-data lines can be on a file, and the file says so.
PASS 5c a fresh pnpm file assemble for the same subject signs a file without the line, exit 0

== Teardown
Stopped the CounterAudit server.
Removed the containers e2e-ca-pg and e2e-bureau-mysql, if they were there.
Could not remove C:\Users\David\AppData\Local\Temp\bureau-e2e-TqTB4T: EBUSY: resource busy or locked, rmdir 'C:\Users\David\AppData\Local\Temp\bureau-e2e-TqTB4T'

All 22 checks passed.
```
