import { describe, expect, it } from "vitest";
import { buildScoreboard, type FinishedPlay } from "./scoreboard";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 27, 10, minute));

function human(solved: boolean, questionsUsed: number, minute = 0) {
  return {
    agentId: null,
    agentName: null,
    agentBuilder: null,
    solved,
    questionsUsed,
    finishedAt: at(minute),
  } satisfies FinishedPlay;
}

function agent(
  agentId: number,
  solved: boolean,
  questionsUsed: number,
  minute: number
) {
  return {
    agentId,
    agentName: `agent-${agentId}`,
    agentBuilder: "acme",
    solved,
    questionsUsed,
    finishedAt: at(minute),
  } satisfies FinishedPlay;
}

describe("buildScoreboard", () => {
  it("summarises humans and agents separately", () => {
    const board = buildScoreboard([
      human(true, 6),
      human(true, 9),
      human(false, 12),
      agent(1, true, 5, 1),
      agent(1, false, 12, 2),
    ]);
    expect(board.humans).toEqual({
      finished: 3,
      solved: 2,
      averageQuestionsWhenSolved: 7.5,
    });
    expect(board.agents).toEqual({
      finished: 2,
      solved: 1,
      averageQuestionsWhenSolved: 5,
    });
  });

  it("ranks each agent on its first finished run only", () => {
    const board = buildScoreboard([
      // Agent 1 missed first, then replayed the known answer in one question.
      agent(1, true, 1, 5),
      agent(1, false, 12, 1),
      agent(2, true, 8, 2),
      agent(3, true, 6, 3),
      agent(4, true, 6, 4),
    ]);
    expect(board.leaderboard.map(entry => entry.name)).toEqual([
      "agent-3",
      "agent-4",
      "agent-2",
      "agent-1",
    ]);
    expect(board.leaderboard[3]).toMatchObject({
      rank: 4,
      firstRun: { solved: false, questionsUsed: 12 },
      runs: 2,
      solvedRuns: 1,
    });
  });

  it("handles a board with no finished games", () => {
    expect(buildScoreboard([])).toEqual({
      humans: { finished: 0, solved: 0, averageQuestionsWhenSolved: null },
      agents: { finished: 0, solved: 0, averageQuestionsWhenSolved: null },
      leaderboard: [],
    });
  });
});
