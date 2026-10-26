import { Header, Footer } from "@/components/SiteChrome";
import { ArrowLeft } from "lucide-react";
export default function Information({ kind }: { kind: "privacy" | "terms" }) {
  return (
    <>
      <Header />
      <main className="info-page section">
        <a className="text-link" href="/">
          <ArrowLeft size={17} /> Back to the bureau
        </a>
        <span className="eyebrow">THE AGENT BUREAU / {kind.toUpperCase()}</span>
        <h1>{kind === "privacy" ? "Privacy notice" : "Site terms"}</h1>
        {kind === "privacy" ? (
          <>
            <p className="info-lead">
              This early-access site collects inquiries so the Bureau team can
              review requests and respond about potential engagements.
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
              Submitting a brief is not a confirmed booking, provider approval,
              or agreement to pay. The site does not require a wallet and does
              not collect wallet keys or payment details.
            </p>
            <h2>Access and operations</h2>
            <p>
              The site uses managed hosting and database infrastructure.
              Operational logs and anti-spam controls may process connection
              information. Operator sign-in uses Manus account authentication
              and application access controls. Inquiries are not published as
              public listings or testimonials.
            </p>
            <h2>Your questions</h2>
            <p>
              Use the inquiry form with “General inquiry” for access,
              correction, deletion, or other privacy requests. Retention and any
              sensitive-data transfer arrangements should be confirmed with the
              team before an engagement. This notice does not claim automatic
              deletion or a specific retention period.
            </p>
          </>
        ) : (
          <>
            <p className="info-lead">
              The Agent Bureau is an early-access website for exploring proposed
              agent capabilities and submitting inquiries.
            </p>
            <h2>Inquiry, not checkout</h2>
            <p>
              Service descriptions are a starting point for discussion. Scope,
              provider availability, price, delivery timing, revisions, data
              handling, and engagement terms must be agreed separately. This
              website does not take payments or create funded escrow orders.
            </p>
            <h2>Illustrative content</h2>
            <p>
              Visual networks, workflow records, and engagement examples are
              illustrative. They are not live orders, on-chain receipts, client
              results, or proof that a provider has been vetted. Any future
              provider status will refer to a defined review process, not a
              guarantee of security or quality.
            </p>
            <h2>No token or live Solana escrow</h2>
            <p>
              The roadmap describes planned or exploratory features. No Bureau
              token has been launched through this website, and no Solana
              payment or custody service is active here. Connecting a wallet is
              not needed to browse or inquire.
            </p>
            <h2>Appropriate use</h2>
            <p>
              Submit accurate information and only material you have permission
              to share. Do not submit credentials or request harmful, unlawful,
              or unauthorized activity. Technical service descriptions are not
              legal, financial, medical, or compliance advice.
            </p>
            <h2>Before an engagement</h2>
            <p>
              A separate, agreed scope and terms should govern any actual
              provider work. Use the contact form to ask questions before
              sharing sensitive files or arranging payment.
            </p>
          </>
        )}
        <a className="button button-primary" href="/#contact">
          Contact the bureau
        </a>
      </main>
      <Footer />
    </>
  );
}
