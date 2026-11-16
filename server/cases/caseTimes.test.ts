import { describe, expect, it } from "vitest";
import { CASES, findCase } from "@shared/cases";
import { caseTimes } from "@shared/caseTimes";

describe("the times a case's public text mentions", () => {
  it("finds every time printed in Case 002, with where it is printed", () => {
    const times = caseTimes(findCase("002")!);
    const at = (label: string) => times.filter(t => t.label === label);
    expect(at("22:08").map(t => t.source)).toEqual(["brief"]);
    expect(at("22:31").map(t => t.source)).toEqual(["intercept"]);
    expect(at("23:02").map(t => t.source)).toEqual(["intercept"]);
    expect(at("21:45").map(t => t.source)).toEqual(["wren"]);
    expect(at("21:58").map(t => t.source)).toEqual(["ibis"]);
    // The driver's tracker gives a span: both ends are hers.
    expect(at("19:20").map(t => t.source)).toEqual(["otter"]);
    expect(at("22:30").map(t => t.source)).toEqual(["otter"]);
  });

  it("puts last night before this morning", () => {
    const times = caseTimes(findCase("002")!);
    const labels = times.map(t => t.label);
    expect(labels.indexOf("22:08")).toBeLessThan(labels.indexOf("07:30"));
    expect(labels[0]).toBe("18:00");
    expect(labels[labels.length - 1]).toBe("07:30");
  });

  it("keeps the sentence each time came from", () => {
    const wren = caseTimes(findCase("002")!).find(t => t.label === "21:45")!;
    expect(wren.sentence).toBe("Missed the 21:45 radio check-in.");
  });

  it("only ever quotes the public text", () => {
    for (const theCase of CASES) {
      const text = [
        ...theCase.brief,
        theCase.intercept,
        `Intercepted ${theCase.interceptTime}.`,
        ...theCase.suspects.flatMap(s => [s.lastNight, s.onFile]),
      ].join(" ");
      const times = caseTimes(theCase);
      expect(times.length).toBeGreaterThan(5);
      for (const time of times) {
        expect(text).toContain(time.sentence);
        expect(time.sentence).toContain(time.label.replace(/^0/, ""));
        const known = [
          "brief",
          "intercept",
          ...theCase.suspects.map(s => s.id),
        ];
        expect(known).toContain(time.source);
      }
    }
  });
});
