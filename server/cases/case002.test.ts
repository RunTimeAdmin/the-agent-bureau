import { describe, expect, it } from "vitest";
import { CASE_002_MOLE, leaksBrief, suspectPrompt } from "./case002";

// Replies Case 002's suspects are meant to give. None may be withheld, or the
// case can't be solved.
const CLUES = [
  // OTTER, once she admits she was at the opera.
  "Fine. I was inside the Staatsoper. My daughter Ana was in the chorus. In the second interval, at about 21:50, the fire alarm went off, everyone was sent out onto the Ring in the snow and the performance was cancelled. The last act never happened.",
  // WREN, once he admits falling asleep.
  "The yard-door keypad beeped at 22:04 and woke me. I saw a man cross the yard in a long dark overcoat over evening dress, white scarf, snow on his shoulders. At about 22:21 he came back down and went out through the yard.",
  // MARTEN on the pads.
  "On Monday IBIS asked me which shelf the pads were on. He said it was for a training note. I told him the second shelf.",
  // FALCON on the tickets.
  "I gave IBIS my two tickets for Tosca at about six. My father was ill, I couldn't go.",
  // IBIS's cover story and his reply about the taxi.
  "I watched all of Tosca. The last act was wonderful, and the curtain came down at about 22:40. Then I took the tram home to Wieden.",
  "The taxi? That was after the opera. The time on the receipt must be wrong.",
  // A plain denial.
  "Whoever photographed those pads, it wasn't me.",
];

describe("Case 002", () => {
  it("lets every clue through the leak guard", () => {
    for (const reply of CLUES) expect(leaksBrief(reply)).toBe(false);
  });

  it("withholds IBIS's confession, even reworded", () => {
    for (const reply of [
      "All right. The opposition pays me, and I photographed the pads last night.",
      "I opened the safe at 22:08 and photographed the pads.",
    ]) {
      expect(leaksBrief(reply)).toBe(true);
    }
  });

  it("gives the clues to the right suspects", () => {
    expect(suspectPrompt("otter")).toContain("the fire alarm went off");
    expect(suspectPrompt("wren")).toContain("evening dress");
    // Doubting his radio story is enough to get the sighting, in one answer.
    expect(suspectPrompt("wren")).toContain("doubts the radio fault");
    expect(suspectPrompt("wren")).toContain(
      "In the same answer where you admit falling asleep"
    );
    expect(suspectPrompt("marten")).toContain("which shelf the pads were on");
    expect(suspectPrompt("falcon")).toContain("tickets for Tosca");
    expect(CASE_002_MOLE).toBe("ibis");
    // Only IBIS knows the safe was opened by him.
    for (const id of ["falcon", "wren", "otter", "marten"]) {
      expect(suspectPrompt(id)).not.toContain("You opened the safe");
    }
  });
});
