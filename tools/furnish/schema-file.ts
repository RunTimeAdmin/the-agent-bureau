import path from "node:path";

// Where `pnpm furnish schema` writes the JSON Schema. The website serves it,
// so SCHEMA_URL in event.ts resolves once the site is rebuilt.
export const SCHEMA_FILE = path.resolve(
  import.meta.dirname,
  "../../client/public/schemas/outcome-event-v0.json"
);
