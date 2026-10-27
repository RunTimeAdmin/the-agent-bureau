import { useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  FileCheck2,
  Minus,
  Plus,
  Scale,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { Header, Footer } from "@/components/SiteChrome";
import HeroVisual from "@/components/HeroVisual";
import ContactForm from "@/components/ContactForm";
import { FURNISH_TOOL_URL, startInquiry } from "@/lib/bureau";

const fileSections = [
  {
    name: "Subject",
    tag: "01 / SUBJECT",
    title: "One operator, however many registrations.",
    text: "The Bureau matches registrations across chains to the operator behind them, and says why: the same owner wallet, a signed claim, or a shared identity. Matches it can't confirm are listed apart and never merged.",
    lines: [
      "Registrations matched across Base, Arc and Solana",
      "The basis for every match, shown",
      "Unconfirmed matches listed separately",
    ],
  },
  {
    name: "Public record",
    tag: "02 / PUBLIC RECORD",
    title: "What the registries already show.",
    text: "First seen, registry events, ownership changes and revoked ratings, read from the public chain registries along with when they were read.",
    lines: [
      "First seen and registry events",
      "Ownership changes on record",
      "Share of ratings revoked",
    ],
  },
  {
    name: "Payment history",
    tag: "03 / PAYMENTS",
    title: "Who it paid, and who paid it.",
    text: "Payments the operator received on-chain, with count, volume and distinct payers, plus subscription charges it paid or missed, over the last 90 and 365 days.",
    lines: [
      "Payments received, by distinct payer",
      "Subscription charges paid and failed",
      "90 and 365 day windows",
    ],
  },
  {
    name: "Reported outcomes",
    tag: "04 / OUTCOMES",
    title: "What businesses saw firsthand.",
    text: "Outcomes reported by the businesses that dealt with the agent: paid, delivered, cut off, disputed. Each line links to its sealed record, and a negative needs evidence before it shows.",
    lines: [
      "Counts by outcome and window",
      "Number of distinct reporting businesses",
      "Evidence behind every negative",
    ],
  },
  {
    name: "Disputes and statements",
    tag: "05 / DISPUTES",
    title: "The owner's side, on the same page.",
    text: "Open and closed disputes with their results, the owner's own statement, and a record of who pulled the file.",
    lines: [
      "Disputes and their results",
      "Owner statement, up to 500 characters",
      "File pulls in the last 90 days",
    ],
  },
  {
    name: "Not on file",
    tag: "06 / BLIND SPOTS",
    title: "And what the Bureau couldn't see.",
    text: "Every file lists its blind spots, such as batched settlement and chains it doesn't read. Nothing is rolled up into a score, a grade or a recommendation.",
    lines: [
      "Known blind spots, listed",
      "No score or grade",
      "No recommendation",
    ],
  },
];

const furnisherCards = [
  {
    icon: ScrollText,
    code: "01 / REPORT",
    title: "What you send",
    text: "One line per outcome: paid, payment failed, delivered, not delivered, disputed, refunded, access revoked or policy violation. Your reference, the agent, the time, an amount for payments, and evidence for negatives.",
    link: { label: "Event format", href: `${FURNISH_TOOL_URL}#csv-columns` },
  },
  {
    icon: FileCheck2,
    code: "02 / SIGN",
    title: "How you send it",
    text: "Export a CSV and sign it with our free, open-source tool. The signature proves the report came from you and hasn't changed since.",
    command: "npx github:RunTimeAdmin/agent-bureau-furnish",
    link: { label: "Signing tool", href: FURNISH_TOOL_URL },
  },
  {
    icon: ShieldCheck,
    code: "03 / PROTECT",
    title: "What we commit to",
    text: "Your reports appear only inside Bureau files: never resold raw, never published, including on Nooscape. Subscribers see your category, not your name, unless you opt in. You can stop at any time.",
    link: { label: "Site terms", href: "/terms" },
  },
];

const rules = [
  {
    icon: Scale,
    title: "Facts, never a verdict.",
    text: "A file says what happened, when, and where the record came from. No line rolls up into a score; subscribers set their own thresholds.",
  },
  {
    icon: FileCheck2,
    title: "Evidence for every negative.",
    text: "A missed payment or a cut-off needs a transaction hash or a log reference. Without evidence it is held, not shown.",
  },
  {
    icon: ShieldCheck,
    title: "Complete, not selective.",
    text: "Businesses report every outcome of a type for the agents they report on, good and bad. Reporting only negatives gets a business dropped.",
  },
];

const parties = [
  {
    label: "01 / FURNISHERS",
    name: "Report outcomes, get files",
    state: "PILOT OPEN",
    copy: "Vetted businesses send signed outcome reports, and each one is sealed in a tamper-evident log before it can reach a file. During the pilot, a business that hasn't set up signing can send a CSV through a channel agreed when it joins; those lines are labeled unsigned.",
  },
  {
    label: "02 / SUBSCRIBERS",
    name: "Check an agent before you transact",
    state: "BY REQUEST",
    copy: "Ask for a file before you serve an agent, bill it later or give it terms. During the pilot, files are assembled by hand and sent signed. Pricing after the pilot is still being set.",
  },
  {
    label: "03 / AGENT OWNERS",
    name: "See and dispute your file",
    state: "FREE",
    copy: "Prove control by signing one message with the wallet that owns the registration. Dispute any line: the business that reported it has 15 days to back it up, or the line comes off. You can also add a statement to your file.",
  },
  {
    label: "04 / LIMITS",
    name: "What the Bureau doesn't do",
    state: "BY DESIGN",
    copy: "No scores, no rankings for sale, no token. Reported data never appears on public sites, and paying never changes a record. Files cover agents and the businesses that run them, and must not be used to decide a person's credit, employment, insurance or housing.",
  },
];

function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={
        reduced || typeof window === "undefined" ? false : { opacity: 0, y: 24 }
      }
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.12 }}
      transition={{ duration: 0.65, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

function Parties() {
  const [open, setOpen] = useState(0);
  return (
    <div className="roadmap-list">
      {parties.map((party, index) => (
        <div
          key={party.name}
          className={`roadmap-item ${open === index ? "open" : ""}`}
        >
          <button
            onClick={() => setOpen(open === index ? -1 : index)}
            aria-expanded={open === index}
            aria-controls={`party-${index}`}
          >
            <span className="mini-label">{party.label}</span>
            <span>{party.name}</span>
            {open === index ? <Minus size={19} /> : <Plus size={19} />}
          </button>
          <div id={`party-${index}`} hidden={open !== index}>
            <span className="phase-state">{party.state}</span>
            <p>{party.copy}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function joinAsFurnisher() {
  startInquiry(
    "Report agent outcomes",
    "We run: \n\nOutcomes we could report: "
  );
}

export default function Bureau() {
  const [section, setSection] = useState(0);
  const active = fileSections[section];
  return (
    <>
      <Header />
      <main>
        <section className="hero" id="top">
          <div className="hero-grid">
            <div className="hero-copy">
              <div className="eyebrow">
                <i /> THE AGENT BUREAU / PILOT 2026
              </div>
              <h1>
                The file on
                <br />
                every <span className="serif">agent.</span>
              </h1>
              <p className="hero-description">
                One file per AI agent operator across five chains, built from
                outcomes reported by the businesses that deal with agents.
                Facts with sources. Never a score.
              </p>
              <div className="hero-actions">
                <a className="button button-primary" href="#furnish">
                  Join as a furnisher <ArrowUpRight size={18} />
                </a>
                <a className="hero-secondary" href="#file">
                  See what a file shows{" "}
                  <span>
                    <ArrowRight size={17} />
                  </span>
                </a>
              </div>
              <div className="hero-assurance">
                <ShieldCheck size={15} />
                <span>Facts, not scores</span>
                <span className="assurance-dot">·</span>
                <span>Owners can dispute</span>
              </div>
            </div>
            <HeroVisual />
          </div>
          <div className="hero-foot">
            <a href="#file">
              <ArrowDown size={14} /> EXPLORE THE FILE
            </a>
            <span>EVIDENCE ON EVERY LINE.</span>
            <span>PILOT 2026</span>
          </div>
        </section>
        <div className="principle-strip" aria-label="Bureau principles">
          <span>
            <i /> FACTS, NOT SCORES
          </span>
          <span>EVIDENCE FOR NEGATIVES</span>
          <span>OWNERS CAN DISPUTE</span>
          <span>FIVE CHAINS</span>
          <span>NO TOKEN</span>
        </div>
        <section className="section process" id="file">
          <Reveal className="section-heading">
            <div>
              <span className="eyebrow section-index">
                01 / WHAT A FILE SHOWS
              </span>
              <h2>
                Everything on record.
                <br />
                <span className="serif">Nothing made up.</span>
              </h2>
            </div>
            <p>
              One file per operator. Every line carries its date, its source
              and its evidence. No line rolls up into a score.
            </p>
          </Reveal>
          <div className="process-grid">
            <div
              className="process-steps"
              role="group"
              aria-label="Sections of a Bureau file"
            >
              {fileSections.map((item, index) => (
                <button
                  key={item.name}
                  className={section === index ? "active" : ""}
                  onClick={() => setSection(index)}
                  aria-pressed={section === index}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <h3>{item.name}</h3>
                  <ArrowUpRight size={19} />
                </button>
              ))}
            </div>
            <div className="process-detail" aria-live="polite">
              <span className="mini-label">{active.tag}</span>
              <h3>{active.title}</h3>
              <p>{active.text}</p>
              <div className="dossier">
                <div className="dossier-head">
                  <span>
                    <FileCheck2 size={16} /> BUREAU FILE
                  </span>
                  <span>EXAMPLE</span>
                </div>
                {active.lines.map(line => (
                  <div key={line}>
                    <Check size={14} />
                    <span>{line}</span>
                  </div>
                ))}
                <div className="dossier-foot">
                  <span>ILLUSTRATIVE</span>
                  <span>NOT A REAL AGENT</span>
                </div>
              </div>
            </div>
          </div>
          <p className="catalog-note">
            <span className="status-dot" />
            <span>
              Files draw on{" "}
              <a href="https://nooscape.si" target="_blank" rel="noreferrer">
                Nooscape
              </a>
              's public agent atlas and{" "}
              <a href="https://sigvara.xyz" target="_blank" rel="noreferrer">
                Sigvara
              </a>
              's on-chain standing, alongside outcomes businesses report.
            </span>
          </p>
        </section>
        <section className="section provider-section" id="furnish">
          <Reveal className="provider-panel">
            <div>
              <span className="eyebrow">
                02 / FOR BUSINESSES THAT DEAL WITH AGENTS
              </span>
              <h2>
                You already know
                <br />
                who pays. <span className="serif">Report it.</span>
              </h2>
              <p>
                If your API, MCP server or marketplace deals with AI agents,
                you know which ones pay, deliver and stay within your rules.
                Report those outcomes, and check every agent's record with the
                businesses that saw it before you.
              </p>
              <button className="button button-primary" onClick={joinAsFurnisher}>
                Join the pilot <ArrowUpRight size={18} />
              </button>
            </div>
            <div className="provider-list">
              <span className="mini-label">WHAT YOU GET</span>
              {[
                "Free Bureau files during the pilot",
                "Alerts on agents you reported on",
                "A record bad operators can't rename away",
              ].map((item, index) => (
                <div key={item}>
                  <span>0{index + 1}</span>
                  <p>{item}</p>
                  <ArrowRight size={16} />
                </div>
              ))}
              <small>
                The 90-day pilot is free for furnishers.
                <br />
                Draft terms, pending legal review.
              </small>
            </div>
          </Reveal>
          <div className="service-grid furnisher-cards">
            {furnisherCards.map((card, index) => {
              const Icon = card.icon;
              const external = card.link.href.startsWith("http");
              return (
                <Reveal key={card.title} delay={Math.min(index * 0.05, 0.15)}>
                  <div className="service-card info">
                    <div className="service-top">
                      <span className="service-icon">
                        <Icon size={23} />
                      </span>
                      <span className="mini-label">{card.code}</span>
                    </div>
                    <div className="service-content">
                      <h3>{card.title}</h3>
                      <p>{card.text}</p>
                      {card.command && (
                        <code className="code-line">{card.command}</code>
                      )}
                    </div>
                    <a
                      className="service-bottom"
                      href={card.link.href}
                      {...(external
                        ? { target: "_blank", rel: "noreferrer" }
                        : {})}
                    >
                      <span>{card.link.label}</span>
                      <ArrowUpRight size={20} />
                    </a>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </section>
        <section className="approach" id="rules">
          <div className="section approach-inner">
            <Reveal>
              <span className="eyebrow section-index">
                03 / THE BUREAU RULES
              </span>
              <h2>
                Facts first.
                <br />
                Fair to
                <br />
                <span className="serif">everyone on file.</span>
              </h2>
              <p className="approach-intro">
                A file only helps if the businesses checking it and the
                operators named in it can both trust it.
              </p>
              <a href="/terms" className="text-link">
                Read the site terms <ArrowUpRight size={18} />
              </a>
            </Reveal>
            <div className="trust-principles">
              {rules.map((item, index) => (
                <Reveal
                  key={item.title}
                  className="trust-principle"
                  delay={index * 0.08}
                >
                  <item.icon size={23} />
                  <div>
                    <span className="mini-label">RULE / 0{index + 1}</span>
                    <h3>{item.title}</h3>
                    <p>{item.text}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>
        <section className="section future-section" id="how">
          <Reveal className="section-heading">
            <div>
              <span className="eyebrow section-index">04 / HOW IT WORKS</span>
              <h2>
                Three parties.
                <br />
                <span className="serif">One record.</span>
              </h2>
            </div>
            <p>
              Businesses report. Subscribers check.
              <br />
              Owners see and answer.
              <br />
              Paying never changes a record.
            </p>
          </Reveal>
          <Parties />
        </section>
        <section className="contact-section" id="contact">
          <div className="section contact-grid">
            <Reveal className="contact-copy">
              <span className="eyebrow">JOIN THE PILOT</span>
              <h2>
                Which side
                <br />
                are <span className="serif">you on?</span>
              </h2>
              <p>
                Report outcomes, ask for a file,
                <br />
                or ask about your own agent's file.
              </p>
              <div className="contact-note">
                <ShieldCheck size={18} />
                <p>
                  This form is the Bureau's contact channel during the pilot.
                  Please don't include credentials, private keys or customer
                  records.
                </p>
              </div>
            </Reveal>
            <Reveal className="contact-form-panel" delay={0.1}>
              <ContactForm />
            </Reveal>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
