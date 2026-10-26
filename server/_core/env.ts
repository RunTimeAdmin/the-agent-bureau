// Server-only values, read at use time so tests can stub them.
export const ENV = {
  get databaseUrl() { return process.env.DATABASE_URL ?? ""; },
  get operatorPassword() { return process.env.OPERATOR_PASSWORD ?? ""; },
  get sessionSecret() { return process.env.SESSION_SECRET ?? ""; },
  get isProduction() { return process.env.NODE_ENV === "production"; },
};
