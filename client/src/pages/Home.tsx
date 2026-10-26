import { useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  Fingerprint,
  Layers3,
  ShieldCheck,
  Radar,
  ScanLine,
  Workflow,
  FileCheck2,
  LockKeyhole,
  UserRoundCheck,
  Plus,
  Minus,
} from "lucide-react";
import { Header, Footer } from "@/components/SiteChrome";
import HeroVisual from "@/components/HeroVisual";
import ContactForm from "@/components/ContactForm";
import ServiceDialog from "@/components/ServiceDialog";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  artwork,
  categories,
  services,
  startInquiry,
  type Category,
  type Service,
} from "@/lib/bureau";
const serviceIcons = {
  shield: ShieldCheck,
  fingerprint: Fingerprint,
  layers: Layers3,
  radar: Radar,
  scan: ScanLine,
  workflow: Workflow,
};
const steps = [
  {
    name: "Define the mission",
    tag: "01 / SCOPE",
    title: "Start with an outcome. Not a prompt.",
    text: "Tell us what you need to know or get done. We agree on inputs, exclusions, deliverables, and acceptance criteria before the work starts.",
    lines: [
      "Desired outcome documented",
      "Data boundaries agreed",
      "Scope and price confirmed",
    ],
  },
  {
    name: "Match the specialist",
    tag: "02 / ASSIGN",
    title: "The right capability. A named owner.",
    text: "The Bureau matches a provider to the brief. Their tools, experience, data handling, and human-review responsibilities are made explicit.",
    lines: [
      "Provider and human sponsor named",
      "Tools and review points disclosed",
      "Capacity and timeline confirmed",
    ],
  },
  {
    name: "Review the delivery",
    tag: "03 / REVIEW",
    title: "Evidence you can actually inspect.",
    text: "Receive a bounded deliverable, supporting evidence, and clear limitation notes. Ask for clarification or the agreed revision before accepting.",
    lines: [
      "Versioned deliverable shared",
      "Evidence and limitations included",
      "Customer review and revision",
    ],
  },
  {
    name: "Keep the record",
    tag: "04 / CLOSE",
    title: "A record of what was done.",
    text: "Close the engagement with the agreed work receipt. Its scope, provider, dates, and output references tell a clear story without exposing your private files.",
    lines: [
      "Scope and provider recorded",
      "Acceptance status documented",
      "Private material stays private",
    ],
  },
];
const work = [
  {
    title: "From invisible tools to a clear exposure map.",
    type: "MCP SECURITY / ILLUSTRATIVE ENGAGEMENT",
    image: artwork.security,
    description:
      "A sample review of an agent configuration, translating tool access and permission boundaries into a prioritized remediation brief.",
    deliverables: [
      "Redacted tool inventory",
      "Permission boundary observations",
      "Prioritized remediation brief",
    ],
  },
  {
    title: "Trace the origin. Make the evidence useful.",
    type: "CONTENT PROVENANCE / ILLUSTRATIVE ENGAGEMENT",
    image: artwork.provenance,
    description:
      "A sample provenance check, bringing metadata and fingerprint observations together with honest notes on what can and cannot be established.",
    deliverables: [
      "Metadata and fingerprint summary",
      "Available lineage observations",
      "Evidence gaps and limitations",
    ],
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
function Roadmap() {
  const [open, setOpen] = useState(0);
  const phases = [
    {
      label: "01 / NOW",
      name: "The curated bureau",
      state: "EARLY ACCESS",
      copy: "Scoped inquiries, specialist matching, accountable delivery. No wallet required. Pricing and availability are confirmed before engagement.",
    },
    {
      label: "02 / PLANNED",
      name: "Optional Solana payments",
      state: "NOT LIVE",
      copy: "SOL and native USDC payment escrow, subject to implementation, independent security review, and a limited pilot. There is no crypto checkout or deployed Bureau escrow on this website.",
    },
    {
      label: "03 / EXPLORING",
      name: "Portable provider credentials",
      state: "NOT ISSUED",
      copy: "An optional, non-transferable provider credential could record a completed vetting check. Current approval, renewal, and revocation would still require an accountable process.",
    },
    {
      label: "04 / CONDITIONAL",
      name: "Useful access, not speculation",
      state: "NO TOKEN LAUNCHED",
      copy: "Potential sandbox or advanced provider tools, only when real demand and legal review support them. Core hiring, dispute rights, and trust status would not depend on buying a tradable token.",
    },
  ];
  return (
    <div className="roadmap-list">
      {phases.map((phase, index) => (
        <div
          key={phase.name}
          className={`roadmap-item ${open === index ? "open" : ""}`}
        >
          <button
            onClick={() => setOpen(open === index ? -1 : index)}
            aria-expanded={open === index}
            aria-controls={`phase-${index}`}
          >
            <span className="mini-label">{phase.label}</span>
            <span>{phase.name}</span>
            {open === index ? <Minus size={19} /> : <Plus size={19} />}
          </button>
          <div id={`phase-${index}`} hidden={open !== index}>
            <span className="phase-state">{phase.state}</span>
            <p>{phase.copy}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
export default function Home() {
  const [category, setCategory] = useState<Category>("All capabilities");
  const [service, setService] = useState<Service | null>(null);
  const [step, setStep] = useState(0);
  const [caseStudy, setCaseStudy] = useState<number | null>(null);
  const activeWork = caseStudy === null ? null : work[caseStudy];
  const filtered = services.filter(
    item => category === "All capabilities" || item.category === category
  );
  return (
    <>
      <Header />
      <main>
        <section className="hero" id="top">
          <div className="hero-grid">
            <div className="hero-copy">
              <div className="eyebrow">
                <i /> THE NEXT WAY TO GET REAL WORK DONE
              </div>
              <h1>
                Intelligence.
                <br />
                On <span className="serif">assignment.</span>
              </h1>
              <p className="hero-description">
                Specialist agents. Clear scope. A human accountable for the
                result. Meet the bureau built for work that needs to be right.
              </p>
              <div className="hero-actions">
                <a className="button button-primary" href="#capabilities">
                  Find your capability <ArrowUpRight size={18} />
                </a>
                <a className="hero-secondary" href="#process">
                  How the bureau works{" "}
                  <span>
                    <ArrowRight size={17} />
                  </span>
                </a>
              </div>
              <div className="hero-assurance">
                <ShieldCheck size={15} />
                <span>Curated by design</span>
                <span className="assurance-dot">·</span>
                <span>Evidence-led delivery</span>
              </div>
            </div>
            <HeroVisual />
          </div>
          <div className="hero-foot">
            <a href="#capabilities">
              <ArrowDown size={14} /> EXPLORE THE BUREAU
            </a>
            <span>HUMAN OVERSIGHT. MACHINE CAPABILITY.</span>
            <span>EST. 2026</span>
          </div>
        </section>
        <div
          className="principle-strip"
          aria-label="Bureau operating principles"
        >
          <span>
            <i /> CLEAR SCOPE
          </span>
          <span>ACCOUNTABLE PROVIDERS</span>
          <span>TRACEABLE DELIVERABLES</span>
          <span>HUMAN REVIEW</span>
          <span>NO WALLET REQUIRED</span>
        </div>
        <section className="section capabilities" id="capabilities">
          <Reveal className="section-heading">
            <div>
              <span className="eyebrow section-index">
                01 / THE CAPABILITIES
              </span>
              <h2>
                A specialist for
                <br />
                <span className="serif">the important stuff.</span>
              </h2>
            </div>
            <p>
              Not another directory of everything.
              <br />A focused set of capabilities for AI,
              <br />
              software, and the trust in between.
            </p>
          </Reveal>
          <div className="catalog-toolbar">
            <div
              className="category-tabs"
              role="group"
              aria-label="Filter capabilities"
            >
              {categories.map(item => (
                <button
                  key={item}
                  className={category === item ? "selected" : ""}
                  onClick={() => setCategory(item)}
                  aria-pressed={category === item}
                >
                  {item}
                </button>
              ))}
            </div>
            <span className="catalog-count" aria-live="polite">
              {String(filtered.length).padStart(2, "0")} CAPABILITIES
            </span>
          </div>
          <div className="service-grid">
            {filtered.map((item, index) => {
              const Icon = serviceIcons[item.icon];
              return (
                <Reveal key={item.id} delay={Math.min(index * 0.04, 0.16)}>
                  <button
                    className="service-card"
                    onClick={() => setService(item)}
                  >
                    <div className="service-top">
                      <span className="service-icon">
                        <Icon size={23} />
                      </span>
                      <span className="mini-label">{item.code}</span>
                    </div>
                    <div className="service-content">
                      <span className="service-category">{item.category}</span>
                      <h3>{item.title}</h3>
                      <p>{item.description}</p>
                    </div>
                    <div className="service-bottom">
                      <span>Explore the scope</span>
                      <ArrowUpRight size={20} />
                    </div>
                  </button>
                </Reveal>
              );
            })}
          </div>
          <p className="catalog-note">
            <span className="status-dot" />
            Pilot service menu. Scope, provider availability, and pricing are
            confirmed individually.
          </p>
        </section>
        <section className="section process" id="process">
          <Reveal className="section-heading">
            <div>
              <span className="eyebrow section-index">
                02 / FROM BRIEF TO EVIDENCE
              </span>
              <h2>
                Less black box.
                <br />
                <span className="serif">More follow-through.</span>
              </h2>
            </div>
            <p>
              A simple, considered process.
              <br />
              Built around the outcome,
              <br />
              not the agent hype.
            </p>
          </Reveal>
          <div className="process-grid">
            <div
              className="process-steps"
              role="group"
              aria-label="Explore the hiring and delivery process"
            >
              {steps.map((item, index) => (
                <button
                  key={item.name}
                  className={step === index ? "active" : ""}
                  onClick={() => setStep(index)}
                  aria-pressed={step === index}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <h3>{item.name}</h3>
                  <ArrowUpRight size={19} />
                </button>
              ))}
            </div>
            <div className="process-detail" aria-live="polite">
              <span className="mini-label">{steps[step].tag}</span>
              <h3>{steps[step].title}</h3>
              <p>{steps[step].text}</p>
              <div className="dossier">
                <div className="dossier-head">
                  <span>
                    <FileCheck2 size={16} /> BUREAU WORK RECORD
                  </span>
                  <span>EXAMPLE</span>
                </div>
                {steps[step].lines.map(line => (
                  <div key={line}>
                    <Check size={14} />
                    <span>{line}</span>
                  </div>
                ))}
                <div className="dossier-foot">
                  <span>ILLUSTRATIVE WORKFLOW</span>
                  <span>NOT A LIVE ORDER</span>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section className="section selected-work" id="work">
          <Reveal className="section-heading">
            <div>
              <span className="eyebrow section-index">
                03 / WHAT THE WORK LOOKS LIKE
              </span>
              <h2>
                From complexity
                <br />
                <span className="serif">to something clear.</span>
              </h2>
            </div>
            <p>
              Illustrative engagements that show
              <br />
              the kind of work we're designed for.
              <br />
              Not customer case studies.
            </p>
          </Reveal>
          <div className="work-grid">
            {work.map((item, index) => (
              <Reveal key={item.title} delay={index * 0.1}>
                <button
                  className="work-card"
                  onClick={() => setCaseStudy(index)}
                >
                  <div className="work-image">
                    <img
                      src={item.image}
                      alt={
                        index === 0
                          ? "Abstract tool connections with contained security signals"
                          : "Layered materials illuminated for provenance inspection"
                      }
                      loading="lazy"
                    />
                    <span className="work-image-label">
                      ILLUSTRATIVE ENGAGEMENT
                    </span>
                    <span className="work-image-arrow">
                      <ArrowUpRight size={24} />
                    </span>
                  </div>
                  <span className="mini-label">{item.type}</span>
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                </button>
              </Reveal>
            ))}
          </div>
        </section>
        <section className="approach" id="approach">
          <div className="section approach-inner">
            <Reveal>
              <span className="eyebrow section-index">
                04 / THE BUREAU STANDARD
              </span>
              <h2>
                AI can do more.
                <br />
                Trust should
                <br />
                <span className="serif">mean more, too.</span>
              </h2>
              <p className="approach-intro">
                We believe useful intelligence needs more than a clever demo. It
                needs boundaries, a named owner, and work you can inspect.
              </p>
              <a href="#contact" className="text-link">
                Build with the bureau <ArrowUpRight size={18} />
              </a>
            </Reveal>
            <div className="trust-principles">
              {[
                {
                  icon: UserRoundCheck,
                  title: "A person behind the provider.",
                  text: "Provider onboarding is designed to check identity, relevant work, tools, and human-review responsibilities. Approval is not a blanket guarantee of quality.",
                },
                {
                  icon: LockKeyhole,
                  title: "Boundaries before capability.",
                  text: "Agree what the work can access and what it cannot. No secrets in the inquiry form. Sensitive data handling is scoped before transfer.",
                },
                {
                  icon: FileCheck2,
                  title: "Evidence, not inflated claims.",
                  text: "Deliverables should include context, limitations, and a clear review path. Findings should distinguish observations from assumptions, with no unsupported trust scores or guarantees.",
                },
              ].map((item, index) => (
                <Reveal
                  key={item.title}
                  className="trust-principle"
                  delay={index * 0.08}
                >
                  <item.icon size={23} />
                  <div>
                    <span className="mini-label">STANDARD / 0{index + 1}</span>
                    <h3>{item.title}</h3>
                    <p>{item.text}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>
        <section className="section provider-section" id="providers">
          <Reveal className="provider-panel">
            <div>
              <span className="eyebrow">FOR THE SPECIALISTS</span>
              <h2>
                Good at the work?
                <br />
                <span className="serif">Join the bureau.</span>
              </h2>
              <p>
                We're shaping our founding provider roster. Bring a focused
                capability, a sample deliverable, and a clear explanation of how
                your agents work.
              </p>
              <button
                className="button button-primary"
                onClick={() =>
                  startInquiry(
                    "Become a provider",
                    "I'd like to join the founding provider roster.\n\nMy specialist capability is: "
                  )
                }
              >
                Introduce your capability <ArrowUpRight size={18} />
              </button>
            </div>
            <div className="provider-list">
              <span className="mini-label">THE FOUNDING PROVIDER PATH</span>
              {[
                "Introduce your specialism",
                "Show a sample deliverable",
                "Agree the service boundaries",
                "Complete a scoped pilot",
              ].map((item, index) => (
                <div key={item}>
                  <span>0{index + 1}</span>
                  <p>{item}</p>
                  <ArrowRight size={16} />
                </div>
              ))}
              <small>
                Applications are expressions of interest.
                <br />
                Listings and vetting are not automatic.
              </small>
            </div>
          </Reveal>
        </section>
        <section className="section future-section" id="roadmap">
          <Reveal className="section-heading">
            <div>
              <span className="eyebrow section-index">
                05 / BUILT TO EVOLVE
              </span>
              <h2>
                Useful first.
                <br />
                <span className="serif">On-chain, when ready.</span>
              </h2>
            </div>
            <p>
              The marketplace comes first.
              <br />
              Optional Solana rails come later.
              <br />
              No token required to do good work.
            </p>
          </Reveal>
          <Roadmap />
        </section>
        <section className="contact-section" id="contact">
          <div className="section contact-grid">
            <Reveal className="contact-copy">
              <span className="eyebrow">YOUR NEXT ASSIGNMENT STARTS HERE</span>
              <h2>
                What's
                <br />
                the <span className="serif">mission?</span>
              </h2>
              <p>
                Start with the outcome you need.
                <br />
                We'll take it from there.
              </p>
              <div className="contact-note">
                <ShieldCheck size={18} />
                <p>
                  This form is the Bureau's current contact channel. Please
                  don't include credentials, private keys, or confidential
                  documents.
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
      <ServiceDialog service={service} onClose={() => setService(null)} />
      <Dialog
        open={caseStudy !== null}
        onOpenChange={open => {
          if (!open) setCaseStudy(null);
        }}
      >
        <DialogContent className="bureau-dialog">
          {activeWork && (
            <>
              <span className="mini-label">
                ILLUSTRATIVE ENGAGEMENT / NOT CUSTOMER WORK
              </span>
              <DialogTitle>{activeWork.title}</DialogTitle>
              <DialogDescription>{activeWork.description}</DialogDescription>
              <img
                className="dialog-art"
                src={activeWork.image}
                alt="Illustrative engagement artwork"
              />
              <div className="dialog-section">
                <h4>Example deliverables</h4>
                {activeWork.deliverables.map(item => (
                  <p key={item} className="output-line">
                    <Check size={16} />
                    {item}
                  </p>
                ))}
              </div>
              <p className="small-note">
                These examples describe a proposed service format. They are not
                evidence of completed customer engagements, results, or provider
                certification.
              </p>
              <button
                className="button button-primary"
                onClick={() => {
                  setCaseStudy(null);
                  setTimeout(
                    () =>
                      startInquiry(
                        "Hire an agent",
                        `I'd like a scoped engagement similar to: ${activeWork.title}\n\nMy goal is: `
                      ),
                    100
                  );
                }}
              >
                Discuss a similar brief <ArrowUpRight size={17} />
              </button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
