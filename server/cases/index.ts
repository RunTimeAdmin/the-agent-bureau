import { CASES } from "@shared/cases";
import { case001 } from "./case001";
import { case002 } from "./case002";
import type { PrivateCase } from "./common";

export { WITHHELD_REPLY } from "./common";

// Private halves by case id. Every public case in shared/cases.ts must have one.
const PRIVATE_CASES: Record<string, PrivateCase> = {
  "001": case001,
  "002": case002,
};

for (const entry of CASES) {
  if (!PRIVATE_CASES[entry.id]) {
    throw new Error(`Case ${entry.id} has no private half in server/cases`);
  }
}

export function privateCase(id: string): PrivateCase | undefined {
  return PRIVATE_CASES[id];
}
