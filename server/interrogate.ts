import Anthropic from "@anthropic-ai/sdk";

// Claude plays each suspect. Low effort keeps replies quick: the brief already
// holds every fact, so a short in-character answer needs little reasoning.
const MODEL = "claude-opus-5-5";

let client: Anthropic | null = null;

export type Exchange = { question: string; answer: string };

// Returns null when the model declines, so the caller can refund the question.
export async function askSuspect(
  system: string,
  history: Exchange[],
  question: string
): Promise<string | null> {
  client ??= new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = history.flatMap(turn => [
    { role: "user" as const, content: turn.question },
    { role: "assistant" as const, content: turn.answer },
  ]);
  messages.push({ role: "user", content: question });

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system,
    messages,
  });
  if (response.stop_reason === "refusal") return null;

  const answer = response.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("")
    .trim();
  return answer || null;
}
