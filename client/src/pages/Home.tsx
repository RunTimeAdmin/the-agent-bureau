import { Link } from "wouter";
import { casePath, CASES, LATEST_CASE, type PublicCase } from "@shared/cases";
import { GameFooter, GameHeader } from "@/components/GameChrome";

// A made-up exchange that shows the core move of the game without giving
// away anything from a real case.
function TrainingFile() {
  return (
    <figure className="home-file" aria-labelledby="training-caption">
      <figcaption id="training-caption">
        <span>Training exercise</span>Two answers that can't both be true
      </figcaption>
      <div className="home-exchange">
        <p className="play-q">ROOK, where were you at nine last night?</p>
        <p className="play-a">
          <b>ROOK</b> At the cinema on Rua Augusta, the 20:40 showing. I{" "}
          <mark>stayed until the credits</mark>.
        </p>
      </div>
      <div className="home-exchange">
        <p className="play-q">FINCH, did you see ROOK last night?</p>
        <p className="play-a">
          <b>FINCH</b> Briefly. She <mark>came out of the cinema at nine</mark>,
          before the film had even finished. She looked in a hurry.
        </p>
      </div>
      <p className="home-stamp" aria-hidden="true">
        Contradiction
      </p>
    </figure>
  );
}

const [featured, ...older] = [...CASES].reverse();
const nextCaseId = String(CASES.length + 1).padStart(3, "0");

function CaseCard({
  theCase,
  featured = false,
}: {
  theCase: PublicCase;
  featured?: boolean;
}) {
  return (
    <article className={`home-case is-open ${featured ? "is-featured" : ""}`}>
      <header className="home-case-head">
        <span>Case {theCase.id}</span>
        <em>{featured ? "Newest" : "Open"}</em>
      </header>
      <h3>{theCase.title}</h3>
      <p>{featured ? theCase.brief[0] : theCase.teaser}</p>
      {featured && (
        <blockquote className="play-intercept">
          <span>Intercepted {theCase.interceptTime}</span>“{theCase.intercept}”
        </blockquote>
      )}
      <ul className="home-case-suspects" aria-label="Suspects">
        {theCase.suspects.map(suspect => (
          <li key={suspect.id}>{suspect.codename}</li>
        ))}
      </ul>
      <Link
        href={casePath(theCase.id)}
        className={featured ? "play-button" : "play-button play-button-ghost"}
      >
        Open Case {theCase.id}
      </Link>
    </article>
  );
}

export default function Home() {
  return (
    <div className="game">
      <GameHeader>
        <nav className="home-nav" aria-label="Main">
          <a href="#how">How it works</a>
          <a href="#cases">Cases</a>
          <Link href="/agents">Agents</Link>
          <Link href="/bureau">The Agent Bureau</Link>
          <Link href={casePath(LATEST_CASE.id)} className="home-nav-cta">
            Play Case {LATEST_CASE.id}
          </Link>
        </nav>
      </GameHeader>

      <main>
        <section className="home-hero">
          <div>
            <p className="home-kicker">An interrogation game</p>
            <h1>
              <span>Five suspects.</span>
              <span>One mole.</span>
              <span>Twelve questions.</span>
            </h1>
            <p className="home-lede">
              Every suspect is an AI agent with a story to protect. Question
              them, catch the lie, and name the mole before your questions run
              out.
            </p>
            <div className="home-actions">
              <Link href={casePath(LATEST_CASE.id)} className="play-button">
                Open Case {LATEST_CASE.id}
              </Link>
              <a href="#how" className="home-link">
                How a case works
              </a>
            </div>
          </div>
          <TrainingFile />
        </section>

        <section className="home-section" id="how">
          <h2>How a case works</h2>
          <ol className="home-steps">
            <li>
              <h3>Read the dossiers</h3>
              <p>
                Each case opens with a briefing, an intercepted message and a
                dossier on every suspect. Every dossier has something that looks
                bad. Most of it is innocent.
              </p>
            </li>
            <li>
              <h3>Question the suspects</h3>
              <p>
                You have {LATEST_CASE.questionLimit} questions to spend across
                all five. Innocent suspects hide their own embarrassing secrets.
                The mole lies about the one thing that matters.
              </p>
            </li>
            <li>
              <h3>Name the mole</h3>
              <p>
                One accusation ends the case. Then you see what really happened,
                and get a result you can share without spoiling it.
              </p>
            </li>
          </ol>
        </section>

        <section className="home-section home-split">
          <h2>The suspects are AI agents</h2>
          <div>
            <p>
              Each suspect runs as its own agent with a private brief: what that
              person did, what they know, and what they're hiding. None of them
              can see the others' answers. You can.
            </p>
            <p>
              That's the whole game. Put two stories side by side and find where
              they break.
            </p>
            <ul className="home-facts">
              <li>
                <b>Separate briefs.</b> A suspect only knows its own side of the
                night.
              </li>
              <li>
                <b>Memory.</b> It remembers every question you've asked it.
              </li>
              <li>
                <b>One liar.</b> The mole keeps to the cover story and never
                confesses.
              </li>
            </ul>
          </div>
        </section>

        <section className="home-section home-split">
          <h2>Bring your own agent</h2>
          <div>
            <p>
              The suspects are AI agents. Can yours catch theirs? Point your own
              agent at any case through a small HTTP API, and see how it does
              against the people who played it in the browser.
            </p>
            <div className="home-actions">
              <Link href="/agents" className="play-button">
                See humans vs agents
              </Link>
            </div>
          </div>
        </section>

        <section className="home-section" id="cases">
          <h2>Cases</h2>
          <div className="home-cases">
            <CaseCard theCase={featured} featured />
            <div className="home-cases-side">
              {older.map(entry => (
                <CaseCard key={entry.id} theCase={entry} />
              ))}
              <article className="home-case is-coming">
                <header className="home-case-head">
                  <span>Case {nextCaseId}</span>
                  <em>Being written</em>
                </header>
                <p>Another place, another crew, another kind of lie.</p>
              </article>
            </div>
          </div>
        </section>

        <section className="home-section home-split">
          <h2>From The Agent Bureau</h2>
          <div>
            <p>
              BUREAU is fiction. Its suspects are invented characters played by
              Claude, an AI model. No real agent, person or business appears in
              a case, and nothing you type in the game goes into a Bureau file.
            </p>
            <p>
              The Agent Bureau's real work is separate: factual files on AI
              agent operators, built from outcomes businesses report. Each
              release rests on a reviewer's signed decision, sealed in a log
              anyone with access can check.
            </p>
            <div className="home-actions home-bureau-links">
              <Link href="/bureau" className="play-button">
                Visit The Agent Bureau
              </Link>
              <Link href="/review-log" className="play-button play-button-ghost">
                See the review log run
              </Link>
            </div>
          </div>
        </section>
      </main>

      <GameFooter />
    </div>
  );
}
