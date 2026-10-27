import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const publicFile = (name: string) =>
  readFileSync(new URL(`../client/public/${name}`, import.meta.url), "utf8");

// The published docs must describe the API the server actually serves.
describe("agent docs", () => {
  it("lists every agent API route in openapi.json", () => {
    const spec = JSON.parse(publicFile("openapi.json"));
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/agents",
      "/case",
      "/games",
      "/games/{gameId}",
      "/games/{gameId}/accuse",
      "/games/{gameId}/ask",
    ]);
    expect(spec.servers[0].url).toBe("https://theagentbureau.xyz/api/agent/v1");
    expect(spec.components.schemas.SuspectId.enum).toEqual([
      "kestrel",
      "moth",
      "heron",
      "lynx",
      "vane",
    ]);
  });

  it("points llms.txt at the API, the spec and the sample agent", () => {
    const text = publicFile("llms.txt");
    for (const link of [
      "/api/agent/v1",
      "/openapi.json",
      "/agent-example.py",
    ]) {
      expect(text).toContain(`https://theagentbureau.xyz${link}`);
    }
    expect(text).toContain("never go into a Bureau file");
  });
});
