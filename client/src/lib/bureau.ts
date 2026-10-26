export type Category =
  | "All capabilities"
  | "Security"
  | "Identity"
  | "Provenance"
  | "Infrastructure";
export type Interest =
  | "Hire an agent"
  | "Become a provider"
  | "Partnership"
  | "General inquiry";
export type Service = {
  id: string;
  title: string;
  category: Exclude<Category, "All capabilities">;
  description: string;
  code: string;
  icon: "shield" | "fingerprint" | "layers" | "radar" | "scan" | "workflow";
  output: string[];
  inputs: string;
  exclusions: string;
};
export const services: Service[] = [
  {
    id: "mcp-exposure",
    title: "MCP exposure review",
    category: "Security",
    description:
      "Know what your agents can reach. Map tool access, permissions, and configuration risks.",
    code: "SEC - 01",
    icon: "shield",
    output: [
      "Tool-surface inventory",
      "Prioritized exposure findings",
      "Practical remediation brief",
    ],
    inputs:
      "Redacted MCP configuration files and a description of your environment. Never share API keys or credentials.",
    exclusions:
      "Not a penetration test, compliance certification, or guarantee that a system is secure.",
  },
  {
    id: "agent-identity",
    title: "Agent identity & trust",
    category: "Identity",
    description:
      "Make identity, ownership, and delegated authority explicit across your agent stack.",
    code: "ID - 02",
    icon: "fingerprint",
    output: [
      "Identity and ownership map",
      "Permission boundary review",
      "Recommended authentication patterns",
    ],
    inputs:
      "An architecture overview and non-sensitive descriptions of your identity providers and agent roles.",
    exclusions:
      "Does not grant credentials, move assets, or certify an agent as safe.",
  },
  {
    id: "aibom",
    title: "SBOM + AI-BOM snapshot",
    category: "Infrastructure",
    description:
      "See the software, models, and dependencies behind the work. One clear inventory.",
    code: "INF - 03",
    icon: "layers",
    output: [
      "Dependency and model inventory",
      "Available provenance metadata",
      "Coverage and limitation notes",
    ],
    inputs:
      "Public repository URLs or agreed, redacted manifests and lock files. Private code handling must be agreed before transfer.",
    exclusions:
      "Inventory is not a full code audit. Transitive coverage depends on the supplied material.",
  },
  {
    id: "provenance",
    title: "Content provenance check",
    category: "Provenance",
    description:
      "Trace the source. Evaluate metadata, fingerprints, and evidence behind AI-assisted content.",
    code: "PRV - 04",
    icon: "scan",
    output: [
      "Metadata and fingerprint report",
      "Available lineage observations",
      "Evidence gaps and next steps",
    ],
    inputs:
      "Content you own or have permission to share, plus any available source and lineage records.",
    exclusions:
      "Does not prove authorship, determine copyright ownership, or provide legal advice.",
  },
  {
    id: "guardrails",
    title: "Agent guardrail review",
    category: "Security",
    description:
      "Define what should never happen. Review approval boundaries and failure-containment patterns.",
    code: "SEC - 05",
    icon: "radar",
    output: [
      "Action and risk boundary map",
      "Human-approval recommendations",
      "Containment and incident checklist",
    ],
    inputs:
      "Agent workflows, planned actions, and existing approval policies. No production credentials.",
    exclusions:
      "Design review only. No autonomous production changes, trading, or asset transfers.",
  },
  {
    id: "workflow",
    title: "Workflow architecture brief",
    category: "Infrastructure",
    description:
      "Turn an ambitious agent idea into a bounded, buildable workflow with clear handoffs.",
    code: "INF - 06",
    icon: "workflow",
    output: [
      "Workflow and handoff design",
      "Tool and integration shortlist",
      "Build scope and acceptance criteria",
    ],
    inputs:
      "Your intended outcome, current stack, constraints, and examples of the work to be performed.",
    exclusions:
      "A scoped design deliverable, not a software implementation or guaranteed business outcome.",
  },
];
export const categories: Category[] = [
  "All capabilities",
  "Security",
  "Identity",
  "Provenance",
  "Infrastructure",
];
export const artwork = {
  hero: "/images/bureau-hero.webp",
  security: "/images/mcp-assurance.webp",
  provenance: "/images/provenance-ledger.webp",
};
export function startInquiry(interest: Interest, message = "") {
  window.dispatchEvent(
    new CustomEvent("bureau-inquiry", { detail: { interest, message } })
  );
  document
    .getElementById("contact")
    ?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
}
