import { useState } from "react";
import { Fingerprint, Wallet, FileCheck2, ArrowUpRight } from "lucide-react";
import { artwork } from "@/lib/bureau";
const nodes = [
  {
    label: "OPERATOR",
    text: "Know who runs it.",
    icon: Fingerprint,
    className: "node-security",
    description: "Registrations matched to one operator, with the basis shown.",
  },
  {
    label: "PAYMENTS",
    text: "Know who it paid.",
    icon: Wallet,
    className: "node-identity",
    description: "On-chain payments and subscription charges, dated.",
  },
  {
    label: "OUTCOMES",
    text: "Know how it behaved.",
    icon: FileCheck2,
    className: "node-evidence",
    description: "What businesses reported, each line with its evidence.",
  },
];
export default function HeroVisual() {
  const [active, setActive] = useState(0);
  return (
    <div className="hero-visual">
      <img
        className="hero-art"
        src={artwork.hero}
        alt="Abstract glass agent stations linked by precise signal paths"
        fetchPriority="high"
      />
      <div className="hero-shade" />
      <div className="visual-topline">
        <span>
          <i /> ONE FILE PER OPERATOR
        </span>
        <span>{String(active + 1).padStart(2, "0")} / 03</span>
      </div>
      <div className="orbit-stage">
        <div className="orbital-ring ring-one" />
        <div className="orbital-ring ring-two" />
        <div className="orbital-ring ring-three" />
        <div className="orbit-center">
          <span className="center-symbol">B</span>
          <span>
            THE BUREAU
            <br />
            FILE
          </span>
        </div>
        <svg className="orbit-paths" viewBox="0 0 600 450" aria-hidden="true">
          <path
            d="M300 230L155 110M300 230L445 160M300 230L365 370"
            stroke="currentColor"
            strokeWidth="1"
            fill="none"
            strokeDasharray="4 8"
          />
        </svg>
        {nodes.map((node, index) => {
          const Icon = node.icon;
          return (
            <button
              key={node.label}
              onClick={() => setActive(index)}
              className={`agent-node ${node.className} ${active === index ? "active" : ""}`}
              aria-pressed={active === index}
            >
              <Icon size={18} />
              <span>{node.label}</span>
              <span className="node-dot" />
            </button>
          );
        })}
      </div>
      <div className="visual-caption" aria-live="polite">
        <div>
          <span className="mini-label">ON EVERY FILE</span>
          <p>{nodes[active].text}</p>
          <small>{nodes[active].description}</small>
        </div>
        <ArrowUpRight size={26} />
      </div>
      <div className="visual-bottomline">
        <span>ILLUSTRATIVE · NOT LIVE DATA</span>
        <span>↗</span>
      </div>
    </div>
  );
}
