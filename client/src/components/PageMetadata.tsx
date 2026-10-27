import { useEffect } from "react";
import { useLocation } from "wouter";
import { casePath, CASES } from "@shared/cases";
const metadata: Record<
  string,
  { title: string; description: string; noindex?: boolean }
> = {
  "/": {
    title: "BUREAU | An Interrogation Game",
    description:
      "Five suspects, one mole, 12 questions. Every suspect is an AI agent with a story to protect. Catch the lie and name the mole.",
  },
  "/agents": {
    title: "BUREAU | Humans vs Agents",
    description:
      "Point your own AI agent at Case 001 through a small HTTP API and see how it does against human players.",
  },
  "/bureau": {
    title: "The Agent Bureau | The File on Every Agent",
    description:
      "One file per AI agent operator across Arc, Base, BNB Chain, Robinhood Chain and Solana, built from outcomes businesses report. Facts with sources, never a score.",
  },
  "/privacy": {
    title: "Privacy Notice | The Agent Bureau",
    description:
      "How The Agent Bureau handles game questions, website inquiries, operator access, Bureau files, and privacy questions during the pilot.",
  },
  "/terms": {
    title: "Site Terms | The Agent Bureau",
    description:
      "What the BUREAU game and the Agent Bureau pilot offer, what Bureau files are and are not, and the limits on how they can be used.",
  },
  "/inbox": {
    title: "Private Operator Inbox | The Agent Bureau",
    description:
      "Private operator access for reviewing The Agent Bureau website inquiries.",
    noindex: true,
  },
};
// Each case page gets its own title, matching the prerendered HTML.
for (const entry of CASES) {
  metadata[casePath(entry.id)] = {
    title: `BUREAU | Case ${entry.id}: ${entry.title}`,
    description: `Five officers, one mole, ${entry.questionLimit} questions. ${entry.teaser}`,
  };
}

export default function PageMetadata() {
  const [path] = useLocation();
  useEffect(() => {
    const page = metadata[path] || {
      title: "Page Not Found | The Agent Bureau",
      description: "This page could not be found. Return to The Agent Bureau.",
      noindex: true,
    };
    document.title = page.title;
    const setMeta = (name: string, content: string, property = false) => {
      let element = document.head.querySelector<HTMLMetaElement>(
        `meta[${property ? "property" : "name"}="${name}"]`
      );
      if (!element) {
        element = document.createElement("meta");
        element.setAttribute(property ? "property" : "name", name);
        document.head.appendChild(element);
      }
      element.content = content;
    };
    setMeta("description", page.description);
    setMeta("og:title", page.title, true);
    setMeta("og:description", page.description, true);
    setMeta("twitter:title", page.title);
    setMeta("twitter:description", page.description);
    if (page.noindex) setMeta("robots", "noindex, nofollow");
    else document.head.querySelector('meta[name="robots"]')?.remove();
  }, [path]);
  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (!anchor) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ behavior: "instant" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [path]);
  return null;
}
