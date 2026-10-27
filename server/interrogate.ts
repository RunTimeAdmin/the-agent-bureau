import Anthropic from "@anthropic-ai/sdk";

// Claude Haiku plays each suspect: a short in-character reply from a fixed
// brief is light work. Move up a tier only if the characters break.
const MODEL = "claude-haiku-5-5";

// Hard ceiling on one reply. Thinking is off, so the whole budget goes to the
// answer; the brief already asks for under 80 words.
const MAX_REPLY_TOKENS = 200;

// A short reply should return quickly or not at all. The SDK default is 10
// minutes with two retries, which lets one in-flight ask sit uncounted for a
// long time; a tight timeout and one retry keep the request bounded.
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;

let client: Anthropic | null = null;

export type Exchange = { question: string; answer: string };

// Returns null when the model declines, so the caller can refund the question.
export async function askSuspect(
  system: string,
  history: Exchange[],
  question: string
): Promise<string | null> {
  client ??= new Anthropic({
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });
  const messages: Anthropic.MessageParam[] = history.flatMap(turn => [
    { role: "user" as const, content: turn.question },
    { role: "assistant" as const, content: turn.answer },
  ]);
  messages.push({ role: "user", content: question });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_REPLY_TOKENS,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    // Every player questioning this suspect sends the same brief, so it is
    // cached and repeat reads bill at a tenth of the input rate.
    system: [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
    ],
    messages,
  });
  if (response.stop_reason === "refusal") return null;

  let answer = response.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("")
    .trim();
  // A reply cut off by the cap ends at its last full sentence instead.
  if (response.stop_reason === "max_tokens") {
    const end = Math.max(
      ...[".", "!", "?", "…"].map(mark => answer.lastIndexOf(mark))
    );
    if (end > 0) answer = answer.slice(0, end + 1);
  }
  return answer || null;
}

// 402 is the API's billing error: no credit left to answer with.
export function isOutOfCredit(error: unknown): boolean {
  return error instanceof Anthropic.APIError && error.status === 402;
}
