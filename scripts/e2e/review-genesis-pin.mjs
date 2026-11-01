// A module loader hook for scripts/e2e/file-expiry.ts only. The Bureau counts review decisions
// only under the genesis pinned in server/reviewLog.ts (REVIEW_GENESIS), whose reviewers' keys
// the operator holds. The test seals its own reviewers' genesis in a local review organization,
// so when server/reviewLog.ts is loaded into the test's process, this replaces the pinned hash
// with the test's genesis hash. The file on disk does not change. TESTNET_GENESIS, while it is
// the same hash, is replaced with it, so the log still counts as the testnet one and only
// test-data decisions count, as now.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

let genesis = null;

export async function initialize(data) {
  genesis = data.genesis;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (
    !url.startsWith("file:") ||
    !new URL(url).pathname.endsWith("/server/reviewLog.ts")
  ) {
    return result;
  }
  const original = await readFile(fileURLToPath(url), "utf8");
  const pinned = /export const REVIEW_GENESIS[^=]*=\s*"([0-9a-f]{64})"/.exec(
    original
  )?.[1];
  if (!pinned) {
    throw new Error(
      "server/reviewLog.ts pins no REVIEW_GENESIS hash for the e2e test to replace"
    );
  }
  const source =
    typeof result.source === "string"
      ? result.source
      : Buffer.from(result.source).toString("utf8");
  if (!source.includes(pinned)) {
    throw new Error(
      "the loaded server/reviewLog.ts does not hold the pinned genesis hash"
    );
  }
  return { ...result, source: source.replaceAll(pinned, genesis) };
}
