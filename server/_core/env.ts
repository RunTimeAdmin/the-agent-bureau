// Server-only values, read at use time so tests can stub them.
export const ENV = {
  get databaseUrl() { return process.env.DATABASE_URL ?? ""; },
  get operatorPassword() { return process.env.OPERATOR_PASSWORD ?? ""; },
  get sessionSecret() { return process.env.SESSION_SECRET ?? ""; },
  // Anything other than an explicit "development" is treated as production, so
  // an unset NODE_ENV does not quietly drop the cookie Secure flag or security
  // headers. The dev server sets NODE_ENV=development.
  get isProduction() { return process.env.NODE_ENV !== "development"; },
};
