import { afterEach, describe, expect, it, vi } from "vitest";

const { create, APIError } = vi.hoisted(() => {
  class APIError extends Error {
    constructor(public status: number) {
      super(`API error ${status}`);
    }
  }
  return { create: vi.fn(), APIError };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    static APIError = APIError;
    messages = { create };
  },
}));

import { askSuspect, isOutOfCredit } from "./interrogate";

function reply(text: string, stop_reason = "end_turn") {
  return { content: [{ type: "text", text }], stop_reason };
}

afterEach(() => create.mockReset());

describe("askSuspect", () => {
  it("asks Haiku for a capped reply with the brief cached up front", async () => {
    create.mockResolvedValue(reply("  I was home by 23:15.  "));

    const answer = await askSuspect(
      "BRIEF",
      [{ question: "Q1", answer: "A1" }],
      "Q2"
    );

    expect(answer).toBe("I was home by 23:15.");
    expect(create).toHaveBeenCalledWith({
      model: "claude-haiku-5-5",
      max_tokens: 200,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system: [
        { type: "text", text: "BRIEF", cache_control: { type: "ephemeral" } },
      ],
      messages: [
        { role: "user", content: "Q1" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "Q2" },
      ],
    });
  });

  it("returns null when the model declines", async () => {
    create.mockResolvedValue({ content: [], stop_reason: "refusal" });
    await expect(askSuspect("BRIEF", [], "Q")).resolves.toBeNull();
  });

  it("ends a reply cut off by the cap at its last full sentence", async () => {
    create.mockResolvedValue(
      reply("I took the tram home. Then I went straight to", "max_tokens")
    );
    await expect(askSuspect("BRIEF", [], "Q")).resolves.toBe(
      "I took the tram home."
    );
  });
});

describe("isOutOfCredit", () => {
  it("is true only for the API's billing error", () => {
    expect(isOutOfCredit(new APIError(402))).toBe(true);
    expect(isOutOfCredit(new APIError(429))).toBe(false);
    expect(isOutOfCredit(new Error("network down"))).toBe(false);
  });
});
