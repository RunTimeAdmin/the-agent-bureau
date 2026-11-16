import { useEffect, useLayoutEffect, useRef, useState } from "react";

// A made-up exchange that shows the core move of the game without giving away
// anything from a real case. It plays once when it comes into view: the two
// questions are asked, the answers are typed out, the two phrases that cannot
// both be true are underlined and joined by a thread, and the stamp lands.
//
// The whole exchange is in the page from the start, so it reads the same with
// no script, with reduced motion, and to a screen reader.

type Line = { who: string | null; text: string; mark?: string };

const LINES: Line[] = [
  { who: null, text: "ROOK, where were you at nine last night?" },
  {
    who: "ROOK",
    text: "At the cinema on Rua Augusta, the 20:40 showing. I stayed until the credits.",
    mark: "stayed until the credits",
  },
  { who: null, text: "FINCH, did you see ROOK last night?" },
  {
    who: "FINCH",
    text: "Briefly. She came out of the cinema at nine, before the film had even finished. She looked in a hurry.",
    mark: "came out of the cinema at nine",
  },
];

// How long each part of the replay takes, in seconds.
const ASK = 0.35; // a question appears, then a pause
const PER_LETTER = 0.014; // an answer is typed
const REST = 0.3; // between lines
const MARK = 0.7; // the underlines draw
const THREAD = 0.7; // the thread runs between them
const STARTS: number[] = [];
let clock = 0.3;
for (const line of LINES) {
  STARTS.push(clock);
  clock += (line.who ? line.text.length * PER_LETTER : ASK) + REST;
}
const MARK_AT = clock;
const THREAD_AT = MARK_AT + MARK;
const STAMP_AT = THREAD_AT + THREAD;
const END = STAMP_AT + 0.5;

function Answer({ line, shown }: { line: Line; shown: number }) {
  // Letters not yet typed keep their place, so nothing jumps as the line fills in.
  const at = line.mark ? line.text.indexOf(line.mark) : -1;
  const part = (from: number, to: number) => {
    const text = line.text.slice(from, to);
    const typed = Math.max(0, Math.min(text.length, shown - from));
    return (
      <>
        {text.slice(0, typed)}
        <span className="is-untyped">{text.slice(typed)}</span>
      </>
    );
  };
  if (at < 0) return part(0, line.text.length);
  const end = at + line.mark!.length;
  return (
    <>
      {part(0, at)}
      <mark>{part(at, end)}</mark>
      {part(end, line.text.length)}
    </>
  );
}

export default function TrainingFile() {
  const figure = useRef<HTMLElement>(null);
  // Past the end until the replay starts: the server and a no-script page show it finished.
  const [t, setT] = useState(END);
  const [thread, setThread] = useState<string | null>(null);
  const [run, setRun] = useState(0);

  // Play once the card is on screen, and again when asked.
  useEffect(() => {
    const el = figure.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let from: number | null = null;
    const step = (ms: number) => {
      from ??= ms;
      const now = (ms - from) / 1000;
      setT(now);
      if (now < END) raf = requestAnimationFrame(step);
    };
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        seen.disconnect();
        setT(0);
        raf = requestAnimationFrame(step);
      },
      { threshold: 0.4 }
    );
    seen.observe(el);
    return () => {
      seen.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [run]);

  // The thread runs from the end of the first phrase to the start of the second.
  useLayoutEffect(() => {
    const el = figure.current;
    if (!el) return;
    const measure = () => {
      const marks = el.querySelectorAll("mark");
      if (marks.length < 2) return;
      const box = el.getBoundingClientRect();
      // From the start of the first phrase, out round the left margin, to the start
      // of the second: the question between them is set to the right, so the
      // thread passes clear of it.
      const a = marks[0].getClientRects()[0];
      const b = marks[1].getClientRects()[0];
      const x1 = a.left - box.left;
      const y1 = a.bottom - box.top + 4;
      const x2 = b.left - box.left;
      const y2 = b.top - box.top - 7;
      // Under the first answer to the card's left margin, down it, and back in over the second.
      const out = 10;
      const mid = (y1 + y2) / 2;
      setThread(
        `M${x1},${y1} C${out},${y1} ${out},${y1} ${out},${mid} S${out},${y2} ${x2},${y2}`
      );
    };
    measure();
    const sized = new ResizeObserver(measure);
    sized.observe(el);
    document.fonts?.ready.then(measure);
    return () => sized.disconnect();
  }, []);

  const done = t >= END;
  const between = (from: number, length: number) =>
    Math.max(0, Math.min(1, (t - from) / length));

  return (
    <figure
      className={`home-file ${t >= STAMP_AT ? "is-stamped" : ""}`}
      aria-labelledby="training-caption"
      ref={figure}
    >
      <figcaption id="training-caption">
        <span>Training exercise</span>Two answers that can't both be true
      </figcaption>
      {[0, 2].map(first => (
        <div
          className={`home-exchange ${t >= STARTS[first] ? "" : "is-waiting"}`}
          key={first}
        >
          <p className="play-q">{LINES[first].text}</p>
          <p
            className={`play-a ${t >= STARTS[first + 1] ? "" : "is-waiting"} ${
              t >= MARK_AT ? "is-marked" : ""
            }`}
          >
            <b>{LINES[first + 1].who}</b>{" "}
            <Answer
              line={LINES[first + 1]}
              shown={
                done
                  ? Infinity
                  : Math.floor((t - STARTS[first + 1]) / PER_LETTER)
              }
            />
          </p>
        </div>
      ))}
      {thread && (
        <svg className="home-thread" aria-hidden="true">
          <path
            d={thread}
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1 - between(THREAD_AT, THREAD)}
          />
        </svg>
      )}
      <p className="home-stamp" aria-hidden="true">
        Contradiction
      </p>
      <button
        type="button"
        className="home-replay"
        hidden={!done}
        onClick={() => setRun(n => n + 1)}
      >
        Replay
      </button>
    </figure>
  );
}
