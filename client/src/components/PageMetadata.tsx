import { useEffect } from "react";
import { useLocation } from "wouter";
const metadata: Record<
  string,
  { title: string; description: string; noindex?: boolean }
> = {
  "/": {
    title: "The Agent Bureau | Intelligence on Assignment",
    description:
      "Specialist agents, clear scope, and human accountability. Explore AI security, identity, software inventory, and provenance capabilities at The Agent Bureau.",
  },
  "/privacy": {
    title: "Privacy Notice | The Agent Bureau",
    description:
      "How The Agent Bureau handles website inquiries, contact information, operator access, and privacy questions during early access.",
  },
  "/terms": {
    title: "Site Terms and Early Access | The Agent Bureau",
    description:
      "Understand proposed capabilities, inquiry-only engagement, illustrative content, and the boundaries of The Agent Bureau early-access website.",
  },
  "/inbox": {
    title: "Private Operator Inbox | The Agent Bureau",
    description:
      "Private operator access for reviewing The Agent Bureau website inquiries.",
    noindex: true,
  },
};
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
