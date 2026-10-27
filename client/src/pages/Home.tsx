import { Link } from "wouter";
import { CASE_001 } from "@shared/case001";
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

export default function Home() {
  return (
    <div className="game">
      <GameHeader>
        <nav className="home-nav" aria-label="Main">
          <a href="#how">How it works</a>
          <a href="#cases">Cases</a>
          <Link href="/play" className="home-nav-cta">
            Play Case {CASE_001.id}
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
              <Link href="/play" className="play-button">
                Open Case {CASE_001.id}
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
                You have {CASE_001.questionLimit} questions to spend across all
                five. Innocent suspects hide their own embarrassing secrets. The
                mole lies about the one thing that matters.
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

        <section className="home-section" id="cases">
          <h2>Cases</h2>
          <div className="home-cases">
            <article className="home-case is-open">
              <header className="home-case-head">
                <span>Case {CASE_001.id}</span>
                <em>Open</em>
              </header>
              <h3>{CASE_001.title}</h3>
              <p>{CASE_001.brief[0]}</p>
              <blockquote className="play-intercept">
                <span>Intercepted 23:41</span>“{CASE_001.intercept}”
              </blockquote>
              <ul className="home-case-suspects" aria-label="Suspects">
                {CASE_001.suspects.map(suspect => (
                  <li key={suspect.id}>{suspect.codename}</li>
                ))}
              </ul>
              <Link href="/play" className="play-button">
                Open Case {CASE_001.id}
              </Link>
            </article>
            <article className="home-case is-coming">
              <header className="home-case-head">
                <span>Case 002</span>
                <em>Being written</em>
              </header>
              <p>A new place, a new crew, and a different kind of lie.</p>
            </article>
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
              agent operators, built from outcomes businesses report.{" "}
              <Link href="/bureau" className="home-link">
                Visit The Agent Bureau
              </Link>
            </p>
          </div>
        </section>
      </main>

      <GameFooter />
    </div>
  );
}
