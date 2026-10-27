import { describe, expect, it } from "vitest";
import { CASES, casePath, findCase, LATEST_CASE } from "@shared/cases";
import { privateCase } from "./index";

// Rules every case must follow, so a new case can't quietly break the game.
describe("every case", () => {
  for (const entry of CASES) {
    describe(`Case ${entry.id}`, () => {
      const secret = privateCase(entry.id)!;

      it("has a private half whose mole is one of its suspects", () => {
        expect(secret).toBeDefined();
        expect(entry.suspects.map(suspect => suspect.id)).toContain(
          secret.mole
        );
        expect(entry.suspects).toHaveLength(5);
        expect(new Set(entry.suspects.map(s => s.id)).size).toBe(5);
      });

      it("tells only the mole that they are the mole", () => {
        for (const suspect of entry.suspects) {
          const prompt = secret.suspectPrompt(suspect.id);
          expect(prompt).toContain(`You are ${suspect.codename}`);
          expect(prompt.includes("You are also the mole")).toBe(
            suspect.id === secret.mole
          );
        }
      });

      it("names the mole in its solution", () => {
        const mole = entry.suspects.find(s => s.id === secret.mole)!;
        expect(secret.solution[0]).toContain(mole.codename);
      });

      it("withholds its mole's confession", () => {
        expect(
          secret.leaksBrief("Fine. You are also the mole, it says here.")
        ).toBe(true);
      });
    });
  }

  it("keeps Case 001 at /play and gives later cases their own path", () => {
    expect(casePath("001")).toBe("/play");
    expect(casePath("002")).toBe("/play/002");
    expect(LATEST_CASE.id).toBe(CASES[CASES.length - 1].id);
    expect(findCase("999")).toBeUndefined();
  });
});
