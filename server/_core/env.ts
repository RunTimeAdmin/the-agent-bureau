// Server-only values, read at use time so tests can stub them.
export const ENV = {
  get databaseUrl() { return process.env.DATABASE_URL ?? ""; },
  get operatorPassword() { return process.env.OPERATOR_PASSWORD ?? ""; },
  get sessionSecret() { return process.env.SESSION_SECRET ?? ""; },
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
  // Arc testnet JSON-RPC for the evidence check (server/evidence.ts). Only read
  // calls are made: no key is held and nothing is sent.
  get arcTestnetRpcUrl() { return process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.io"; },
  // Arc testnet's explorer (Blockscout), read by the funding screen
  // (server/fundingScreen.ts) for a payer's transfers. Read calls only.
  get arcTestnetExplorerUrl() { return process.env.ARC_TESTNET_EXPLORER_URL || "https://explorer.testnet.arc.io"; },
};
