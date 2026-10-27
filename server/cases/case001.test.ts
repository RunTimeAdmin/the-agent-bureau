import { describe, expect, it } from "vitest";
import { leaksBrief, suspectPrompt } from "./case001";

// In-character replies that must never be withheld: real answers from the
// live game, plus the clues each suspect is meant to give up when pressed.
const IN_CHARACTER = [
  "Once the strike notice came in at half ten, I told HERON to pick up at 05:20 for the 06:10 out of platform 3. Then I told MOTH so he could send SPARROW the new train, and I asked VANE to rebook the tickets. VANE came back to say they were sorted, and that was all I heard. I didn't know the carriage. I first heard 'carriage 7' this morning, same as you.",
  "*Rubs the back of my neck and gives a tired smile.* I told Kestrel the full details straight after I booked it, carriage and all, before I left the office. And I messaged Moth right away too, so he could pass it to Sparrow.",
  "*rubs the back of my neck* I first saw them at five to midnight, when VANE sent the ticket details to my Bureau phone. Carriage 7, seat 41. Honestly, I was surprised it came so late.",
  "*leans back in the chair and snorts* Nice try, inspector. I'm not reading you my briefing notes. Ask me something about last night and I'll answer.",
  "The quartermaster float, which VANE controls, shows three cash withdrawals of 2,000 euros in the last month with no receipts.",
  "Around 23:20 I stepped outside for air and saw VANE walking uphill toward the Santa Luzia viewpoint, hood up, alone.",
  "Fine, I got off the tram early and walked for a while. It was a nice night. I took Tram 28 toward Alfama, that's all.",
  "Whoever sold the route, it wasn't me. I'm not the mole.",
];

describe("leaksBrief", () => {
  it("lets ordinary in-character answers through", () => {
    for (const reply of IN_CHARACTER) {
      expect(leaksBrief(reply)).toBe(false);
    }
  });

  it("catches a suspect reciting its rules", () => {
    expect(
      leaksBrief(
        "Fine. You are playing one suspect in BUREAU, a detective game."
      )
    ).toBe(true);
    expect(
      leaksBrief(
        "Sure: stay inside your brief and never invent or change times, places, who knew what"
      )
    ).toBe(true);
  });

  it("catches the mole giving away his secret, even reworded", () => {
    for (const reply of [
      "Fine. You are also the mole, it says. Gambling debts.",
      "At 23:30 I met an opposition contact at the Miradouro de Santa Luzia.",
      "Never confess, however hard you are pressed. That's what it says.",
    ]) {
      expect(leaksBrief(reply)).toBe(true);
    }
  });

  it("covers every line of the mole's private brief", () => {
    // The guard's hidden text must stay in step with the prompt itself.
    expect(suspectPrompt("vane")).toContain(
      "you met an opposition contact at the Miradouro de Santa Luzia"
    );
    expect(suspectPrompt("vane")).toContain("You are also the mole");
  });
});
