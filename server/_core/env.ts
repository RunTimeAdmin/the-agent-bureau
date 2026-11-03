// Server-only values, read at use time so tests can stub them.
export const ENV = {
  get databaseUrl() { return process.env.DATABASE_URL ?? ""; },
  get operatorPassword() { return process.env.OPERATOR_PASSWORD ?? ""; },
  // Trimmed: a hosting panel can keep a newline pasted after the value.
  get sessionSecret() { return (process.env.SESSION_SECRET ?? "").trim(); },
  get operatorLoginAddresses() { return process.env.OPERATOR_LOGIN_ADDRESSES ?? ""; },
  // Anything other than an explicit "development" is treated as production, so
  // an unset NODE_ENV does not quietly drop the cookie Secure flag or security
  // headers. The dev server sets NODE_ENV=development.
  get isProduction() { return process.env.NODE_ENV !== "development"; },
  // CounterAudit, the system of record for furnished outcome events. Only the
  // operator intake script uses these. The org id pins proofs to the Bureau's
  // own CounterAudit organization; the ingest key must have the ingest role.
  get counterauditApiUrl() { return process.env.COUNTERAUDIT_API_URL || "https://api.counteraudit.io"; },
  get counterauditOrgId() { return process.env.COUNTERAUDIT_ORG_ID ?? ""; },
  get counterauditIngestKey() { return process.env.COUNTERAUDIT_INGEST_KEY ?? ""; },
  // A read key for the Bureau's own organization (COUNTERAUDIT_ORG_ID), for its evidence seals.
  get counterauditReadKey() { return process.env.COUNTERAUDIT_READ_KEY ?? ""; },
  // Arc testnet JSON-RPC for the evidence check (server/evidence.ts). Only read
  // calls are made: no key is held and nothing is sent.
  get arcTestnetRpcUrl() { return process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.io"; },
  // Arc testnet's explorer (Blockscout), read by the funding screen
  // (server/fundingScreen.ts) for a payer's transfers. Read calls only.
  get arcTestnetExplorerUrl() { return process.env.ARC_TESTNET_EXPLORER_URL || "https://explorer.testnet.arc.io"; },
  // The independent review log (docs/review-log-design.md): the CounterAudit organization
  // reviewers seal their records in, and the Bureau's own read-only key to it, for pnpm review
  // sync. A reviewer's machine instead holds that reviewer's ingest key, for pnpm review submit.
  get counterauditReviewOrgId() { return process.env.COUNTERAUDIT_REVIEW_ORG_ID ?? ""; },
  get counterauditReviewReadKey() { return process.env.COUNTERAUDIT_REVIEW_READ_KEY ?? ""; },
  get counterauditReviewIngestKey() { return process.env.COUNTERAUDIT_REVIEW_INGEST_KEY ?? ""; },
  // A head of the review log someone already holds, as "sequence:entryhash": from a reviewer's own
  // receipt or an earlier pnpm review head. pnpm file verify --current, which reads without the
  // Bureau's database, refuses a log that does not reach it (review AB-01).
  get counterauditReviewMinHead() { return process.env.COUNTERAUDIT_REVIEW_MIN_HEAD ?? ""; },
};
