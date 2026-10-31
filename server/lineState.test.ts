import { describe, expect, it } from "vitest";
import {
  displayStateFor,
  lineStates,
  relationProblem,
  type Line,
} from "./lineState";

const WALLET = "0x090F6D72F49ABaBbD3FfD2ebA26D6B8A374b5b77";

function line(overrides: Partial<Line> = {}): Line {
  return {
    id: 1,
    furnisherId: "fur_levymerchant1",
    eventId: "charge-8-1",
    subjectRef: { wallet: WALLET },
    dataClass: "test",
    proofOk: true,
    evidenceStatus: null,
    displayState: "unverified",
    relationType: null,
    relationTargetEventId: null,
    ...overrides,
  };
}

let nextId = 2;
function relating(type: Line["relationType"], overrides: Partial<Line> = {}) {
  const id = nextId++;
  return line({
    id,
    eventId: `later-${id}`,
    relationType: type,
    relationTargetEventId: "charge-8-1",
    ...overrides,
  });
}

describe("lineStates", () => {
  it("keeps sealed, source signed and evidence verified apart", () => {
    expect(lineStates(line({ proofOk: false }), [])).toEqual({
      sealed: true,
      source_signed: false,
      evidence_verified: false,
      disputed: false,
      withdrawn: false,
      superseded: false,
    });
    expect(lineStates(line({ evidenceStatus: "verified" }), [])).toMatchObject({
      source_signed: true,
      evidence_verified: true,
    });
    expect(
      lineStates(line({ evidenceStatus: "needs_review" }), [])
    ).toMatchObject({ evidence_verified: false });
  });

  it.each([
    ["withdraws", { withdrawn: true }, "withdrawn"],
    ["supersedes", { superseded: true }, "superseded"],
    ["corrects", { superseded: true }, "superseded"],
    ["disputes", { disputed: true }, "disputed"],
  ] as const)("a later %s line marks the target", (type, states, display) => {
    const result = lineStates(line(), [relating(type)]);
    expect(result).toMatchObject(states);
    expect(displayStateFor(result)).toBe(display);
  });

  it("ranks a withdrawal over a replacement over a dispute", () => {
    const all = [
      relating("disputes"),
      relating("corrects"),
      relating("withdraws"),
    ];
    expect(displayStateFor(lineStates(line(), all))).toBe("withdrawn");
    expect(displayStateFor(lineStates(line(), all.slice(0, 2)))).toBe(
      "superseded"
    );
    expect(displayStateFor(lineStates(line(), []))).toBe("unverified");
  });

  it("drops a dispute the furnisher has withdrawn, but not a withdrawn correction or withdrawal", () => {
    const withdrawn = { displayState: "withdrawn" as const };
    expect(lineStates(line(), [relating("disputes", withdrawn)]).disputed).toBe(
      false
    );
    expect(
      lineStates(line(), [relating("corrects", withdrawn)]).superseded
    ).toBe(true);
    expect(
      lineStates(line(), [relating("withdraws", withdrawn)]).withdrawn
    ).toBe(true);
    // A dispute that is itself disputed or superseded still stands.
    expect(
      lineStates(line(), [relating("disputes", { displayState: "disputed" })])
        .disputed
    ).toBe(true);
  });

  it("never returns verified, even when every check passed", () => {
    const states = lineStates(line({ evidenceStatus: "verified" }), []);
    expect(displayStateFor(states)).toBe("unverified");
  });
});

describe("relationProblem", () => {
  it("lets a signed line about the same subject act", () => {
    expect(relationProblem(relating("withdraws"), line())).toBeNull();
  });

  it("reads a subject that an older MariaDB returned as JSON text", () => {
    const asText = line({
      subjectRef: JSON.stringify({
        wallet: WALLET,
      }) as unknown as Line["subjectRef"],
    });
    expect(relationProblem(relating("withdraws"), asText)).toBeNull();
  });

  it("matches a wallet subject without case", () => {
    const lower = relating("withdraws", {
      subjectRef: { wallet: WALLET.toLowerCase() },
    });
    expect(relationProblem(lower, line())).toBeNull();
  });

  it.each([
    [
      "a line whose own proof has not passed",
      { proofOk: false },
      "its own proof has not passed",
    ],
    [
      "a line about a different subject",
      { subjectRef: { wallet: "0x451567A35648445143768d3D6e9072A50BB2d85F" } },
      "it names a different subject",
    ],
    [
      "a DID subject against a wallet subject",
      { subjectRef: { did: `did:sigvara:5042002:${WALLET}` } },
      "it names a different subject",
    ],
    [
      "a live line acting on a test line",
      { dataClass: "live" as const },
      "a live line cannot act on a test line",
    ],
  ])("stops %s", (_name, overrides, problem) => {
    const r = relating("withdraws", overrides);
    expect(relationProblem(r, line())).toBe(problem);
    expect(lineStates(line(), [r]).withdrawn).toBe(false);
  });

  it("ignores a line whose relation points at itself", () => {
    const self = line({
      relationType: "withdraws",
      relationTargetEventId: "charge-8-1",
    });
    expect(relationProblem(self, self)).toBe("it points at itself");
    expect(lineStates(self, [self]).withdrawn).toBe(false);
  });
});
