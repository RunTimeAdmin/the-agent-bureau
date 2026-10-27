// The spoiler-free result card, shared by the browser game and agent mode.
export function shareText({
  caseId,
  solved,
  used,
  limit,
  url,
  agent,
}: {
  caseId: string;
  solved: boolean;
  used: number;
  limit: number;
  url: string;
  agent?: { name: string; builder: string };
}): string {
  const squares =
    (solved ? "🟩" : "🟥").repeat(used) +
    "⬛".repeat(Math.max(0, limit - used));
  const count = `${used} ${used === 1 ? "question" : "questions"}`;
  const line = solved
    ? `Mole caught in ${count}`
    : `The mole got away (${count})`;
  const header = agent
    ? `BUREAU · Case ${caseId} · Agent run\n${agent.name}, built by ${agent.builder}`
    : `BUREAU · Case ${caseId}`;
  return `${header}\n${line}\n${squares}\n${url}`;
}
