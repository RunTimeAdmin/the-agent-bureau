// Every playable case, oldest first. The public halves live here and are
// shared by the browser, the agent API and the server; each case's private
// briefs and answer live under server/cases/.

export type SuspectFile = {
  id: string;
  codename: string;
  name: string;
  role: string;
  lastNight: string;
  onFile: string;
};

export type PublicCase = {
  id: string;
  title: string;
  /** One sentence for share previews and the case list. */
  teaser: string;
  questionLimit: number;
  brief: string[];
  intercept: string;
  interceptTime: string;
  orders: string;
  suspects: SuspectFile[];
};

import { CASE_001 } from "./case001";
import { CASE_002 } from "./case002";

export const CASES: PublicCase[] = [CASE_001, CASE_002];
export const LATEST_CASE = CASES[CASES.length - 1];

export function findCase(id: string): PublicCase | undefined {
  return CASES.find(entry => entry.id === id);
}

/** Case 001 keeps the original /play address so old share links still work. */
export function casePath(id: string): string {
  return id === "001" ? "/play" : `/play/${id}`;
}

export function codenameOf(entry: PublicCase, suspectId: string): string {
  return (
    entry.suspects.find(suspect => suspect.id === suspectId)?.codename ??
    suspectId.toUpperCase()
  );
}
