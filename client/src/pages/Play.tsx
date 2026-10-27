import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { CASE_001, type SuspectId } from "@shared/case001";
import { GameFooter, GameHeader } from "@/components/GameChrome";
import { trpc } from "@/lib/trpc";

const STORAGE_KEY = `bureau-play-${CASE_001.id}`;
const LIMIT = CASE_001.questionLimit;

// Storage can be blocked (private windows, strict settings). The game still
// works without it; the player just can't resume after a reload.
function readStoredPlay(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storePlay(playId: string | null) {
  try {
    if (playId) window.localStorage.setItem(STORAGE_KEY, playId);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Resume is a convenience; ignore.
  }
}

function codename(id: SuspectId) {
  return CASE_001.suspects.find(suspect => suspect.id === id)!.codename;
}

function shareText(solved: boolean, used: number, origin: string) {
  const squares =
    (solved ? "🟩" : "🟥").repeat(used) +
    "⬛".repeat(Math.max(0, LIMIT - used));
  const line = solved
    ? `Mole caught in ${used} ${used === 1 ? "question" : "questions"}`
    : `The mole got away (${used} ${used === 1 ? "question" : "questions"})`;
  return `BUREAU · Case ${CASE_001.id}\n${line}\n${squares}\n${origin}/play`;
}

function Meter({ used }: { used: number }) {
  return (
    <div
      className="play-meter"
      role="img"
      aria-label={`${LIMIT - used} of ${LIMIT} questions left`}
    >
      {Array.from({ length: LIMIT }, (_, index) => (
        <i key={index} className={index < used ? "is-used" : ""} />
      ))}
      <span>{LIMIT - used} left</span>
    </div>
  );
}

function Intercept() {
  return (
    <blockquote className="play-intercept">
      <span>Intercepted 23:41</span>“{CASE_001.intercept}”
    </blockquote>
  );
}

function Brief({
  onStart,
  starting,
  error,
}: {
  onStart: () => void;
  starting: boolean;
  error: string | null;
}) {
  return (
    <section className="play-brief">
      <span className="play-eyebrow">Case {CASE_001.id} / Eyes only</span>
      <h1>{CASE_001.title}</h1>
      {CASE_001.brief.map(paragraph => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      <Intercept />
      <p className="play-orders">{CASE_001.orders}</p>
      <button
        className="play-button"
        onClick={onStart}
        disabled={starting}
        type="button"
      >
        {starting ? "Opening the case…" : "Open the case"}
      </button>
      {error && (
        <p className="play-error" role="alert">
          {error}
        </p>
      )}
      <p className="play-fine">
        The suspects are played by Claude, an AI model. Your questions are
        stored with your game and sent to Anthropic to write the replies, so
        leave personal details out of them. <Link href="/privacy">Privacy</Link>
      </p>
    </section>
  );
}

type Turn = { suspect: SuspectId; question: string; answer: string };

function Investigation({
  playId,
  used,
  turns,
  onAccused,
}: {
  playId: string;
  used: number;
  turns: Turn[];
  onAccused: () => void;
}) {
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<SuspectId>("kestrel");
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [accusing, setAccusing] = useState(false);
  const [choice, setChoice] = useState<SuspectId | null>(null);
  const transcript = useRef<HTMLOListElement>(null);
  const ask = trpc.play.ask.useMutation();
  const accuse = trpc.play.accuse.useMutation({
    onSuccess: state => {
      utils.play.get.setData({ playId }, state);
      onAccused();
    },
  });

  const suspect = CASE_001.suspects.find(entry => entry.id === selected)!;
  const thread = turns.filter(turn => turn.suspect === selected);
  const outOfQuestions = used >= LIMIT;

  // Scroll the transcript box, not the page, to the newest exchange.
  useEffect(() => {
    const list = transcript.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [selected, thread.length, pending]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const asked = question.trim();
    if (asked.length < 3 || ask.isPending) return;
    setAskError(null);
    setPending(asked);
    setQuestion("");
    try {
      await ask.mutateAsync({ playId, suspect: selected, question: asked });
      await utils.play.get.invalidate({ playId });
    } catch (error) {
      setQuestion(asked);
      setAskError(
        error instanceof Error ? error.message : "That didn't go through."
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <details className="play-briefing">
        <summary>Briefing and intercept</summary>
        {CASE_001.brief.map(paragraph => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        <Intercept />
      </details>

      <div className="play-board">
        <nav className="play-suspects" aria-label="Suspects">
          {CASE_001.suspects.map(entry => {
            const asked = turns.filter(
              turn => turn.suspect === entry.id
            ).length;
            return (
              <button
                key={entry.id}
                type="button"
                aria-pressed={entry.id === selected}
                className="play-suspect"
                onClick={() => {
                  setSelected(entry.id);
                  setAskError(null);
                }}
                disabled={ask.isPending}
              >
                <strong>{entry.codename}</strong>
                <span>{entry.role}</span>
                <em>
                  {asked} {asked === 1 ? "question" : "questions"}
                </em>
              </button>
            );
          })}
        </nav>

        <section
          className="play-room"
          aria-label={`${suspect.codename} interrogation`}
        >
          <header className="play-dossier">
            <h2>
              {suspect.codename} <span>{suspect.name}</span>
            </h2>
            <dl>
              <dt>Role</dt>
              <dd>{suspect.role}</dd>
              <dt>Last night</dt>
              <dd>{suspect.lastNight}</dd>
              <dt>Flagged</dt>
              <dd className="play-flag">{suspect.onFile}</dd>
            </dl>
          </header>

          <ol ref={transcript} className="play-transcript" aria-live="polite">
            {thread.length === 0 && !pending && (
              <li className="play-empty">
                {suspect.codename} is waiting. Ask your first question.
              </li>
            )}
            {thread.map((turn, index) => (
              <li key={index}>
                <p className="play-q">{turn.question}</p>
                <p className="play-a">
                  <b>{suspect.codename}</b> {turn.answer}
                </p>
              </li>
            ))}
            {pending && (
              <li>
                <p className="play-q">{pending}</p>
                <p className="play-a is-pending">
                  <b>{suspect.codename}</b> <span>…</span>
                </p>
              </li>
            )}
          </ol>

          {outOfQuestions ? (
            <p className="play-out">
              You're out of questions. Time to name the mole.
            </p>
          ) : (
            <form className="play-ask" onSubmit={submit}>
              <label htmlFor="play-question" className="sr-only">
                Question for {suspect.codename}
              </label>
              <input
                id="play-question"
                value={question}
                onChange={event => setQuestion(event.target.value)}
                maxLength={280}
                autoComplete="off"
                placeholder={`Ask ${suspect.codename} something…`}
                disabled={ask.isPending}
              />
              <button
                className="play-button"
                type="submit"
                disabled={ask.isPending || question.trim().length < 3}
              >
                Ask
              </button>
            </form>
          )}
          {askError && (
            <p className="play-error" role="alert">
              {askError}
            </p>
          )}
        </section>
      </div>

      <section className="play-accuse" aria-label="Accusation">
        {accusing ? (
          <>
            <h2>Who is the mole?</h2>
            <p>You get one accusation. It ends the case.</p>
            <div className="play-choices" role="radiogroup">
              {CASE_001.suspects.map(entry => (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={choice === entry.id}
                  onClick={() => setChoice(entry.id)}
                >
                  {entry.codename}
                </button>
              ))}
            </div>
            <div className="play-accuse-actions">
              <button
                className="play-button play-button-danger"
                type="button"
                disabled={!choice || accuse.isPending}
                onClick={() =>
                  choice && accuse.mutate({ playId, suspect: choice })
                }
              >
                {choice ? `Accuse ${codename(choice)}` : "Pick a suspect"}
              </button>
              <button
                className="play-link"
                type="button"
                onClick={() => {
                  setAccusing(false);
                  setChoice(null);
                }}
              >
                Keep investigating
              </button>
            </div>
            {accuse.error && (
              <p className="play-error" role="alert">
                {accuse.error.message}
              </p>
            )}
          </>
        ) : (
          <button
            className="play-button play-button-ghost"
            type="button"
            onClick={() => setAccusing(true)}
            disabled={ask.isPending}
          >
            Name the mole
          </button>
        )}
      </section>
    </>
  );
}

function Verdict({
  used,
  verdict,
}: {
  used: number;
  verdict: {
    accused: SuspectId;
    solved: boolean;
    mole: SuspectId;
    solution: string[];
  };
}) {
  const [copied, setCopied] = useState(false);
  const text = shareText(verdict.solved, used, window.location.origin);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className={`play-verdict ${verdict.solved ? "is-solved" : ""}`}>
      <span className="play-eyebrow">
        Case {CASE_001.id} / {verdict.solved ? "Closed" : "Unsolved"}
      </span>
      <h1 ref={heading} tabIndex={-1}>
        {verdict.solved ? "Mole caught." : "The mole got away."}
      </h1>
      <p className="play-lead">
        You accused {codename(verdict.accused)} after {used}{" "}
        {used === 1 ? "question" : "questions"}.
      </p>
      <ul className="play-solution">
        {verdict.solution.map(line => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="play-share">
        <pre>{text}</pre>
        <button className="play-button" type="button" onClick={copy}>
          {copied ? "Copied" : "Copy your result"}
        </button>
      </div>
      <p className="play-fine">Case 002 is being written. Come back for it.</p>
    </section>
  );
}

export default function Play() {
  const [playId, setPlayId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readStoredPlay()
  );
  const [startError, setStartError] = useState<string | null>(null);
  const game = trpc.play.get.useQuery(
    { playId: playId ?? "" },
    { enabled: playId !== null, retry: false }
  );
  const start = trpc.play.start.useMutation({
    onSuccess: ({ playId: id }) => {
      storePlay(id);
      setPlayId(id);
    },
    onError: error => setStartError(error.message),
  });

  // A stored game the server no longer knows: forget it and show the brief.
  useEffect(() => {
    if (game.error?.data?.code === "NOT_FOUND") {
      storePlay(null);
      setPlayId(null);
    }
  }, [game.error]);

  const state = game.data;
  const used = state?.questionsUsed ?? 0;

  let body;
  if (!playId) {
    body = (
      <Brief
        onStart={() => {
          setStartError(null);
          start.mutate();
        }}
        starting={start.isPending}
        error={startError}
      />
    );
  } else if (!state) {
    body = (
      <p className="play-loading" role="status">
        {game.error ? game.error.message : "Opening the case…"}
      </p>
    );
  } else if (state.verdict) {
    body = <Verdict used={used} verdict={state.verdict} />;
  } else {
    body = (
      <Investigation
        playId={playId}
        used={used}
        turns={state.turns}
        onAccused={() => window.scrollTo({ top: 0 })}
      />
    );
  }

  return (
    <div className="game">
      <GameHeader>
        <span className="play-case">
          Case {CASE_001.id} · {CASE_001.title}
        </span>
        {state && !state.verdict && <Meter used={used} />}
      </GameHeader>
      <main className="play-main">{body}</main>
      <GameFooter />
    </div>
  );
}
