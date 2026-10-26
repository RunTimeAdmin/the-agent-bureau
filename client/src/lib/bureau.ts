export type Interest =
  | "Report agent outcomes"
  | "Request a Bureau file"
  | "I operate an agent"
  | "General inquiry";
export const FURNISH_TOOL_URL =
  "https://github.com/RunTimeAdmin/agent-bureau-furnish";
export const artwork = {
  hero: "/images/bureau-hero.webp",
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
