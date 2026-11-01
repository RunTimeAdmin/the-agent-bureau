import type { ReactNode } from "react";
import { ArrowUpRight, Check, ShieldCheck, X } from "lucide-react";
import { Header, Footer } from "@/components/SiteChrome";

// One run of the independent review log on testnet, 31 October 2026, against the
// production CounterAudit API and the Bureau's database (docs/two-person-review.md,
// docs/review-log-design.md). Every id below is real and checkable with a read key
// to the testnet review organization.

const REVIEW_ORG = "ad7b94fc-05be-45e6-9124-62f576f2d812";
const GENESIS = "8cb804864151e37ef952ddfef76ff788dffe6508bab7d50cfb17a5f51b5456df";
const DESIGN_URL =
  "https://github.com/RunTimeAdmin/the-agent-bureau/blob/master/docs/review-log-design.md";

type Step = {
  position: ReactNode;
  title: string;
  text: ReactNode;
  facts?: [string, string][];
  output?: string;
  result?: { ok: boolean; label: string };
};

const reviewSteps: Step[] = [
  {
    position: (
      <>
        SEQ<b>0–2</b>
      </>
    ),
    title: "Three reviewers sign one genesis",
    text: "Each testnet reviewer made an Ed25519 key, signed the same genesis naming all three, and sealed it with their own key. All three saw the same genesis hash, which the Bureau and CounterAudit both pin.",
    facts: [
      ["Genesis hash", GENESIS],
      ["rev_testnet1", "ed25519:cDXnzRJ4znsK6bW_k7Xn0Wnp2FDmOLPguXWt_RPz2v4"],
      ["rev_testnet2", "ed25519:HM1Xr7fk4yjykWmKoK84FZMWubORUt3l3d75eHNf-X4"],
      ["rev_testnet3", "ed25519:8u_dWiYgLkRi3XJNfTFwyzkxtR_4wfuVA-pp-cANbEI"],
    ],
    output: `sequence 0: rev_testnet1 signed the genesis of rev_testnet1, rev_testnet2, rev_testnet3
sequence 1: rev_testnet2 signed the genesis of rev_testnet1, rev_testnet2, rev_testnet3
sequence 2: genesis of rev_testnet1, rev_testnet2, rev_testnet3 took effect, signed by all of them`,
  },
  {
    position: "LINE",
    title: "A line waits for review",
    text: "The pilot line: a delivered outcome, test data, signed by the pilot furnisher and sealed in CounterAudit. Its proof passed. No machine check exists for a delivery, so a person must judge it and waive the evidence with a reason.",
    facts: [
      ["Line", "fur_bureaupilot01/pilot-test-20261030234110"],
      ["Signed event", "569ef03a85983fea9fa02c50487ee59dc5bcc9ae6e5995192c14d04b558cbe0c"],
      ["Sealed as", "packet 29879d36-30e6-49e4-baed-524a08a1787f"],
    ],
    output: `delivered  test data  shown unverified
proof passed; evidence needs_review: no machine check exists for delivered outcomes`,
  },
  {
    position: (
      <>
        SEQ<b>3</b>
      </>
    ),
    title: "A reviewer decides, and seals it themselves",
    text: "Testnet reviewer 1 signed an approval that waives the evidence. It is bound to this line, this version of its event, its data class and the evidence as they saw it. They sealed it in the review log with their own key and kept CounterAudit's signed receipt.",
    facts: [
      ["Decision", "approve_with_waiver, by rev_testnet1"],
      ["Reason", "Testnet demo: the pilot delivery was checked by hand"],
      ["Sealed as", "packet fff8bbc2-00c4-4a7d-8110-031d79e25563"],
      [
        "Signature",
        "ed25519:6rR2KaFr-zScm8Pxlxn3K5_CP3q8K3-iiuLNvQlzo8P6qyJpXq60C_hN9mJObDhgGlSid1XrzqDnemvSdUN0DQ",
      ],
    ],
  },
  {
    position: "SYNC",
    title: "The Bureau reads the chain and releases the line",
    text: "The operator's sync read the new packet and settled every line. One reviewer is enough for test data. The run printed the new state as verified, its name until review finding M-04 renamed it released: a release records what the checks and reviewers found, not that the outcome happened.",
    output: `fur_bureaupilot01/pilot-test-20261030234110: unverified -> released
sealed: rev_testnet1 approve_with_waiver at sequence 3
released (one reviewer, test data)`,
    result: { ok: true, label: "Released through the review log" },
  },
];

const keySteps: Step[] = [
  {
    position: (
      <>
        REQ<b>A</b>
      </>
    ),
    title: "The admin asks for a new key",
    text: "In the review organization, CounterAudit answers with an approval request instead of a key.",
    facts: [
      ["Request", "2564c6a7-55a8-4b9f-8c99-bfd07bf5d6a7"],
      ["Needs", "1 reviewer's signed approval"],
    ],
  },
  {
    position: "SIGN",
    title: "Reviewer 2 reads it and signs",
    text: "The approval covers this request's id, organization, operation and the SHA-256 of its payload. CounterAudit checked it against reviewer 2's current key in the review log and ran the request. The key's secret was never shown.",
    output: `create a key with role "ingest", labelled "testnet demo ingest", expiring in 7 days`,
    result: { ok: true, label: "Created on one reviewer's approval" },
  },
  {
    position: (
      <>
        REQ<b>B</b>
      </>
    ),
    title: "The admin asks to revoke that key",
    text: "The request names the key well enough for a reviewer to tell whose it is. Revoking takes two different reviewers.",
    facts: [
      ["Request", "983fba95-29a2-4eb4-8ef8-26ce54adf486"],
      ["Key", 'role "ingest", labelled "testnet demo ingest", prefix ca_live_d3da2c1a'],
    ],
  },
  {
    position: "REUSE",
    title: "An old approval cannot be spent again",
    text: "Reviewer 2's approval of request A, sent for request B:",
    output: `403  reviewer_approval_refused: the approval is for another request`,
    result: { ok: false, label: "Refused" },
  },
  {
    position: "1 OF 2",
    title: "Reviewer 1 approves",
    text: "One of the two approvals it needs. Nothing runs yet.",
    output: `"executed": false, "reviewer_approvals_remaining": 1`,
  },
  {
    position: "2 OF 2",
    title: "Reviewer 3 approves, and it runs",
    text: "Two different reviewers, each signing this exact request.",
    output: `"executed": true, "operation": "revoke_key"`,
    result: { ok: true, label: "Revoked on two reviewers' approvals" },
  },
];

function Chain({ steps, label }: { steps: Step[]; label: string }) {
  return (
    <ol className="rl-chain" aria-label={label}>
      {steps.map(step => (
        <li key={step.title}>
          <span className="rl-pos">{step.position}</span>
          <div className="rl-step">
            <h3>{step.title}</h3>
            <p>{step.text}</p>
            {step.facts && (
              <dl className="rl-facts">
                {step.facts.map(([term, value]) => (
                  <div key={term}>
                    <dt>{term}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {step.output && <pre className="rl-output">{step.output}</pre>}
            {step.result && (
              <span className={step.result.ok ? "rl-result is-ok" : "rl-result is-no"}>
                {step.result.ok ? <Check size={14} /> : <X size={14} />}
                {step.result.label}
              </span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function ReviewLog() {
  return (
    <>
      <Header />
      <main className="review-log">
        <section className="section rl-hero">
          <div className="eyebrow">
            <i /> THE AGENT BUREAU / REVIEW LOG / TESTNET RUN, 31 OCTOBER 2026
          </div>
          <h1>
            Reviewers seal it.
            <br />
            <span className="serif">Nobody relays it.</span>
          </h1>
          <p className="rl-lede">
            A line goes on a Bureau file only when reviewers release it. Their decisions never pass through the operator: each reviewer
            seals their own signed record in a review log kept in CounterAudit, and
            the Bureau and CounterAudit each work out from that log who the
            reviewers are and what they decided. This is one run of the whole flow
            on the production services, with the real ids.
          </p>
          <div className="rl-notice" role="note">
            <ShieldCheck size={18} />
            <p>
              <b>Operator-held testnet reviewers.</b> The three reviewers here are
              keys the operator holds, named as such. With one party holding every
              key the two-person guarantee does not hold, so while this testnet
              genesis is pinned the Bureau counts no decision on live data and
              releases no live line. Before any live data, independent reviewers
              seal a genesis of their own and it replaces this one.
            </p>
          </div>
        </section>

        <section className="section rl-section">
          <div className="rl-shows">
            {[
              [
                "The operator relays nothing",
                "The reviewer sealed their approval with their own key. The Bureau read it from the log; the operator only ran the sync.",
              ],
              [
                "Two systems, one answer",
                "The Bureau and CounterAudit each replay the log by the same rules and name the same three reviewers.",
              ],
              [
                "Keys need reviewers",
                "In the review organization a new key took one reviewer's signature of that exact request, and revoking it took two.",
              ],
            ].map(([title, text], index) => (
              <div key={title}>
                <span className="mini-label">0{index + 1}</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="section rl-section" id="log">
          <span className="eyebrow section-index">THE REVIEW LOG</span>
          <h2>
            Four sealed positions.
            <br />
            <span className="serif">One released line.</span>
          </h2>
          <p className="rl-intro">
            Testnet review organization <code>{REVIEW_ORG}</code> in CounterAudit.
            Each position is a sealed packet in its hash chain, numbered from 0.
          </p>
          <Chain steps={reviewSteps} label="The review log, in sequence order" />
        </section>

        <section className="section rl-section" id="keys">
          <span className="eyebrow section-index">KEYS IN THE REVIEW ORGANIZATION</span>
          <h2>
            No key changes
            <br />
            <span className="serif">without reviewers.</span>
          </h2>
          <p className="rl-intro">
            Whoever administers the review organization could otherwise issue or
            revoke its keys alone. Each change here was an approval request that
            ran only on reviewers' signatures over that exact request.
          </p>
          <Chain steps={keySteps} label="Two key changes and their approvals" />
        </section>

        <section className="section rl-section rl-split">
          <div>
            <span className="eyebrow section-index">CHECK IT YOURSELF</span>
            <ul className="rl-list">
              <li>
                With a read key to the testnet review organization,{" "}
                <code>GET /v1/audit/review-org</code> on api.counteraudit.io returns
                the pinned genesis hash and the reviewers CounterAudit counts, with
                their public keys.
              </li>
              <li>
                <code>GET /v1/audit/verify/&lt;packet_id&gt;</code> with the same key
                returns each sealed record, signature included. Any Ed25519 library
                verifies it against the public keys above.
              </li>
            </ul>
            <a className="text-link" href={DESIGN_URL} target="_blank" rel="noreferrer">
              Read the review log design <ArrowUpRight size={18} />
            </a>
          </div>
          <div>
            <span className="eyebrow section-index">BEFORE LIVE DATA</span>
            <ul className="rl-list">
              <li>
                Three independent reviewers make their own keys and seal a genesis in
                a review organization of their own. Its hash replaces the testnet pin
                in the Bureau and in CounterAudit.
              </li>
              <li>
                Subscribers receive a verifiable, redacted release bundle for each
                released line.
              </li>
            </ul>
            <a className="text-link" href="/bureau">
              Back to The Agent Bureau <ArrowUpRight size={18} />
            </a>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
