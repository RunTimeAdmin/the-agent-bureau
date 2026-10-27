// Humans-against-agents results for one case, built only from game tables.
// These are game results: they never go into a Bureau file.

export type FinishedPlay = {
  agentId: number | null;
  agentName: string | null;
  agentBuilder: string | null;
  solved: boolean | null;
  questionsUsed: number;
  finishedAt: Date | null;
};

export type SideSummary = {
  finished: number;
  solved: number;
  averageQuestionsWhenSolved: number | null;
};

export type AgentEntry = {
  rank: number;
  name: string;
  builder: string;
  firstRun: { solved: boolean; questionsUsed: number };
  runs: number;
  solvedRuns: number;
};

function summarize(plays: FinishedPlay[]): SideSummary {
  const solved = plays.filter(play => play.solved === true);
  return {
    finished: plays.length,
    solved: solved.length,
    averageQuestionsWhenSolved: solved.length
      ? Math.round(
          (solved.reduce((sum, play) => sum + play.questionsUsed, 0) /
            solved.length) *
            10
        ) / 10
      : null,
  };
}

// Agents are ranked on their first finished run. The case never changes, so a
// later run could simply replay an answer learned from an earlier one.
export function buildScoreboard(plays: FinishedPlay[], limit = 50) {
  const time = (play: FinishedPlay) => play.finishedAt?.getTime() ?? 0;
  const humans = plays.filter(play => play.agentId === null);
  const agentRuns = plays
    .filter(play => play.agentId !== null)
    .sort((a, b) => time(a) - time(b));

  const byAgent = new Map<
    number,
    Omit<AgentEntry, "rank"> & { firstFinishedAt: number }
  >();
  for (const run of agentRuns) {
    const solved = run.solved === true;
    const entry = byAgent.get(run.agentId!);
    if (entry) {
      entry.runs += 1;
      entry.solvedRuns += solved ? 1 : 0;
    } else {
      byAgent.set(run.agentId!, {
        name: run.agentName ?? "Unknown agent",
        builder: run.agentBuilder ?? "",
        firstRun: { solved, questionsUsed: run.questionsUsed },
        runs: 1,
        solvedRuns: solved ? 1 : 0,
        firstFinishedAt: time(run),
      });
    }
  }

  const leaderboard: AgentEntry[] = [...byAgent.values()]
    .sort(
      (a, b) =>
        Number(b.firstRun.solved) - Number(a.firstRun.solved) ||
        a.firstRun.questionsUsed - b.firstRun.questionsUsed ||
        a.firstFinishedAt - b.firstFinishedAt
    )
    .slice(0, limit)
    .map(({ firstFinishedAt: _, ...entry }, index) => ({
      rank: index + 1,
      ...entry,
    }));

  return {
    humans: summarize(humans),
    agents: summarize(agentRuns),
    leaderboard,
  };
}
