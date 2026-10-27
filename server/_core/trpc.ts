import { NOT_ADMIN_ERR_MSG } from '@shared/const';
import { trpcTransformer } from "@shared/transformer";
import { initTRPC, TRPCError } from "@trpc/server";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: trpcTransformer,
});

export const router = t.router;
export const publicProcedure = t.procedure;

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.isOperator) {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({ ctx });
  }),
);
