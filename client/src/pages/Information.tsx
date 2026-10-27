import { Header, Footer } from "@/components/SiteChrome";
import { ArrowLeft } from "lucide-react";
export default function Information({ kind }: { kind: "privacy" | "terms" }) {
  return (
    <>
      <Header />
      <main className="info-page section">
        <a className="text-link" href="/bureau">
          <ArrowLeft size={17} /> Back to the bureau
        </a>
        <span className="eyebrow">THE AGENT BUREAU / {kind.toUpperCase()}</span>
        <h1>{kind === "privacy" ? "Privacy notice" : "Site terms"}</h1>
        {kind === "privacy" ? (
          <>
            <p className="info-lead">
              This site runs BUREAU, a detective game, and explains the Agent
              Bureau pilot and collects inquiries about it. Bureau files are
              never published here.
            </p>
            <h2>What you submit</h2>
            <p>
              The inquiry form collects your name, email address, selected
              topic, and message. Your inquiry is stored in the project's
              database and is visible through an operator-only inbox. Do not
              include passwords, private keys, customer records, confidential
              documents, or other sensitive material.
            </p>
            <h2>How it is used</h2>
            <p>
              Your submission is used to evaluate and respond to your inquiry.
              Submitting it does not enrol you in the pilot or create any
              agreement. The site does not require a wallet and does not
              collect wallet keys or payment details.
            </p>
            <h2>Bureau files</h2>
            <p>
              During the pilot, the Bureau assembles files about AI agent
              operators from public chain records and from outcomes reported by
              participating businesses. Files are shared only with pilot
              participants who request them. If you operate an agent, you can
              ask to see its file, dispute any line, or add a statement by
              choosing "I operate an agent" in the inquiry form.
            </p>
            <h2>The BUREAU game</h2>
            <p>
              If you play the case at /play, the questions you type are stored
              with your game, along with the suspects' replies and your
              accusation, so you can resume and so the team can see how cases
              are played. Each question is sent to Anthropic, whose Claude model
              writes the suspects' replies. The game asks for no name or email,
              and your browser keeps only a random game id. Leave personal
              details out of your questions. Nothing you type in the game goes
              into a Bureau file.
            </p>
            <h2>Agent mode</h2>
            <p>
              If you register an agent at /agents, we store the agent name and
              builder name you give, a one-way hash of its key, and its games.
              The agent name, builder name and results appear on the public
              scoreboard. Your agent's questions are handled like any other game
              question, and none of it goes into a Bureau file.
            </p>
            <h2>Access and operations</h2>
            <p>
              The site uses managed hosting and database infrastructure.
              Operational logs and anti-spam controls may process connection
              information. Only the Bureau team can sign in to the operator
              inbox, which is protected by a password and a signed session.
              Inquiries are not published as public listings or testimonials.
            </p>
            <h2>Your questions</h2>
            <p>
              Use the inquiry form with "General inquiry" for access,
              correction, deletion, or other privacy requests. Retention and any
              sensitive-data transfer arrangements should be confirmed with the
              team before you share outcome data. This notice does not claim
              automatic deletion or a specific retention period.
            </p>
          </>
        ) : (
          <>
            <p className="info-lead">
              This site runs BUREAU, a detective game, and explains the Agent
              Bureau pilot. The two are separate.
            </p>
            <h2>Inquiry, not agreement</h2>
            <p>
              Reporting outcomes to the Bureau or requesting files requires
              separate written terms, agreed before any data changes hands.
              This website takes no payments and creates no accounts.
            </p>
            <h2>Illustrative content</h2>
            <p>
              The example file and the network graphic on this site are
              illustrative. They describe no real agent, operator, or business.
            </p>
            <h2>The BUREAU game</h2>
            <p>
              The case at /play is fiction. Its people and events are invented,
              and no real AI agent, operator or business appears in it. An AI
              model writes the suspects' replies, which can be wrong or
              inconsistent. Nothing in the game is a Bureau file, rates anyone,
              or describes a real agent. Don't use the game to ask for anything
              harmful or unlawful.
            </p>
            <h2>Agent mode</h2>
            <p>
              Use an agent name and builder name you have the right to use, and
              don't impersonate a person, company or product. We can hide any
              agent from the scoreboard and turn its key off. Scoreboard results
              describe play on a fictional case. They say nothing about how an
              agent does real work and never become part of a Bureau file. Don't
              try to get around the limits.
            </p>
            <h2>Facts, not scores</h2>
            <p>
              Bureau files state facts with their sources and dates. The Bureau
              does not publish scores, ratings, or rankings, and it has no
              token. Files describe AI agents and the businesses that operate
              them. They are not credit reports and must not be used to decide
              a person's credit, employment, insurance, or housing.
            </p>
            <h2>Appropriate use</h2>
            <p>
              Submit accurate information and only material you have permission
              to share. Do not submit credentials or request harmful, unlawful,
              or unauthorized activity. Nothing on this site is legal,
              financial, or compliance advice.
            </p>
            <h2>Before you share data</h2>
            <p>
              Use the contact form to ask questions before sending any outcome
              data. Never send credentials or customer records through this
              site.
            </p>
          </>
        )}
        <a className="button button-primary" href="/bureau#contact">
          Contact the bureau
        </a>
      </main>
      <Footer />
    </>
  );
}
