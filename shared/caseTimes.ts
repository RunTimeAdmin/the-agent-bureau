import type { PublicCase } from "./cases";

// Every clock time a case's public text mentions, in the order of the night, for
// the board on the briefing page. Nothing here is inferred: each entry is a
// time printed in the briefing, the intercept or a suspect's dossier, with the
// sentence it came from. The private briefs never reach this file.

export type CaseTime = {
  /** Minutes from noon of the day before the case opens: 0 to 1439. */
  at: number;
  /** As printed, for example "22:08". */
  label: string;
  /** Where it is printed: the briefing, the intercept, or a suspect's id. */
  source: "brief" | "intercept" | string;
  /** The sentence the time appears in. */
  sentence: string;
};

const CLOCK = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;

// A case is briefed the morning after: an hour from noon on is last night, and
// an hour before noon is this morning. Both cases so far are written that way.
const fromNoon = (hour: number, minute: number) =>
  ((hour + 12) % 24) * 60 + minute;

// A full stop followed by a space ends a sentence. None of the case text
// abbreviates with one.
const sentencesOf = (text: string) =>
  text
    .split(/(?<=[.!?])\s+/)
    .map(part => part.trim())
    .filter(Boolean);

function timesIn(text: string, source: CaseTime["source"]): CaseTime[] {
  const found: CaseTime[] = [];
  for (const sentence of sentencesOf(text)) {
    for (const match of sentence.matchAll(CLOCK)) {
      found.push({
        at: fromNoon(Number(match[1]), Number(match[2])),
        label: match[0].padStart(5, "0"),
        source,
        sentence,
      });
    }
  }
  return found;
}

export function caseTimes(theCase: PublicCase): CaseTime[] {
  const all = [
    ...theCase.brief.flatMap(paragraph => timesIn(paragraph, "brief")),
    ...timesIn(theCase.intercept, "intercept"),
    // The intercept is stamped with the time it was picked up.
    {
      at: fromNoon(
        Number(theCase.interceptTime.slice(0, 2)),
        Number(theCase.interceptTime.slice(3, 5))
      ),
      label: theCase.interceptTime,
      source: "intercept",
      sentence: `Intercepted ${theCase.interceptTime}.`,
    },
    ...theCase.suspects.flatMap(suspect => [
      ...timesIn(suspect.lastNight, suspect.id),
      ...timesIn(suspect.onFile, suspect.id),
    ]),
  ];
  return all.sort((a, b) => a.at - b.at);
}
