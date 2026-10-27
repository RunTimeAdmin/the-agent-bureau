import { NOT_ADMIN_ERR_MSG } from '@shared/const';
import { trpcTransformer } from "@shared/transformer";
import { initTRPC, TRPCError } from "@trpc/server";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: trpcTransformer,
  // Outside development, don't hand the client a stack trace, and replace the
  // raw message of an unexpected (non-tRPC) error, which can carry SQL text,
  // with a generic one. Deliberate tRPC errors keep their own message.
  errorFormatter({ shape, error }) {
    const isDev = process.env.NODE_ENV === "development";
    const masked = !isDev && error.code === "INTERNAL_SERVER_ERROR";
    return {
      ...shape,
      message: masked ? "Something went wrong. Please try again." : shape.message,
      data: { ...shape.data, stack: isDev ? shape.data.stack : undefined },
    };
  },
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
