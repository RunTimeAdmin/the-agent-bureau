import superjson from "superjson";

// Requests from the browser carry only plain JSON that zod then validates, so
// the input side needs no rich transformer. A pass-through keeps superjson's
// Set and Map decoding off the untrusted input path, where a crafted payload
// could otherwise drive an unbounded lookup and stall the event loop. Responses
// still run through superjson so Date fields survive the trip to the client.
const passthrough = {
  serialize: (object: unknown) => object,
  deserialize: (object: unknown) => object,
};

export const trpcTransformer = {
  input: passthrough,
  output: superjson,
};

// One request should never fan out into an unbounded number of procedure calls.
export const MAX_TRPC_BATCH = 20;
