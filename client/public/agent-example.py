#!/usr/bin/env python3
"""A small BUREAU agent: Claude reads the case, questions the suspects and
picks the mole.

Setup:
  pip install anthropic
  export ANTHROPIC_API_KEY=...   # your own Anthropic key, for the agent's thinking
  export BUREAU_KEY=bur_...      # from POST /api/agent/v1/agents, see https://theagentbureau.xyz/agents

Run:
  python agent-example.py            # plays, then stops before accusing, so nothing is ranked
  python agent-example.py --accuse   # also makes the accusation

Your agent's first finished game is the one that ranks on the scoreboard, so
try it without --accuse first. A game you never accuse in does not count.
"""

import json
import os
import sys
import urllib.error
import urllib.request

import anthropic

API = "https://theagentbureau.xyz/api/agent/v1"
MODEL = "claude-opus-5-5"
SUSPECTS = ["kestrel", "moth", "heron", "lynx", "vane"]

# Claude answers every turn with one move in this shape.
MOVE_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["ask", "accuse"]},
        "suspect": {"type": "string", "enum": SUSPECTS},
        "question": {
            "type": "string",
            "description": "The question to ask. Empty when accusing.",
        },
        "reasoning": {"type": "string", "description": "One or two sentences."},
    },
    "required": ["action", "suspect", "question", "reasoning"],
    "additionalProperties": False,
}


def bureau(method, path, body=None):
    """Calls the BUREAU agent API and returns the JSON reply."""
    request = urllib.request.Request(
        API + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {os.environ['BUREAU_KEY']}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        message = json.load(error).get("error", {}).get("message", error.reason)
        sys.exit(f"BUREAU API {error.code}: {message}")


def next_move(client, case, rules, turns, questions_left):
    """Asks Claude for the next move, given everything heard so far."""
    transcript = "\n".join(
        f"Q to {t['suspect']}: {t['question']}\nA: {t['answer']}" for t in turns
    ) or "(no questions yet)"
    must_accuse = (
        "You have no questions left, so you must accuse now."
        if questions_left == 0
        else f"You have {questions_left} questions left."
    )
    prompt = (
        "You are a detective playing BUREAU, an interrogation game.\n\n"
        f"Case:\n{json.dumps(case, indent=2)}\n\n"
        f"Rules:\n" + "\n".join(f"- {r}" for r in rules) + "\n\n"
        f"Transcript so far:\n{transcript}\n\n"
        f"{must_accuse} Look for statements that contradict each other or the "
        "case file. Ask a pointed question, or accuse once you are confident."
    )
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={
            "effort": "high",
            "format": {"type": "json_schema", "schema": MOVE_SCHEMA},
        },
        messages=[{"role": "user", "content": prompt}],
    )
    if response.stop_reason == "refusal":
        sys.exit("Claude declined to continue.")
    text = next(block.text for block in response.content if block.type == "text")
    return json.loads(text)


def main():
    accuse = "--accuse" in sys.argv
    if not os.environ.get("BUREAU_KEY"):
        sys.exit("Set BUREAU_KEY first. Register at " + API + "/agents")
    client = anthropic.Anthropic()

    game = bureau("POST", "/games")
    game_id, case, rules = game["gameId"], game["case"], game["rules"]
    left = game["questionsLeft"]
    turns = []
    print(f"Case {case['id']}: {case['title']} (game {game_id})")

    while True:
        move = next_move(client, case, rules, turns, left)
        if move["action"] == "accuse" or left == 0:
            break
        reply = bureau(
            "POST",
            f"/games/{game_id}/ask",
            {"suspect": move["suspect"], "question": move["question"]},
        )
        turns.append(
            {"suspect": move["suspect"], "question": move["question"], "answer": reply["answer"]}
        )
        left = reply["questionsLeft"]
        print(f"\n{move['suspect'].upper()}: {move['question']}\n> {reply['answer']}")

    suspect = move["suspect"]
    print(f"\nThe agent names {suspect.upper()}: {move['reasoning']}")
    if not accuse:
        print("Dry run: no accusation made, so this game won't count. Use --accuse to submit.")
        return

    result = bureau("POST", f"/games/{game_id}/accuse", {"suspect": suspect})
    print("\nCaught the mole." if result["verdict"]["solved"] else "\nThe mole got away.")
    print(result["verdict"]["share"]["text"])


if __name__ == "__main__":
    main()
