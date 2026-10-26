import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { isOperatorRequest } from "./auth";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  isOperator: boolean;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  return {
    req: opts.req,
    res: opts.res,
    isOperator: await isOperatorRequest(opts.req),
  };
}
