import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { trpcTransformer } from "@shared/transformer";
import { Router } from "wouter";
import { casePath, CASES, findCase } from "@shared/cases";
import { trpc } from "./lib/trpc";
import Agents from "./pages/Agents";
import Bureau from "./pages/Bureau";
import Home from "./pages/Home";
import Information from "./pages/Information";
import NotFound from "./pages/NotFound";
import Play from "./pages/Play";
export function caseTitle(caseId: string): string {
  return `BUREAU | Case ${caseId}: ${findCase(caseId)!.title}`;
}

export function caseDescription(caseId: string): string {
  const entry = findCase(caseId)!;
  return `Five officers, one mole, ${entry.questionLimit} questions. ${entry.teaser}`;
}

/** Every case page and the file it is prerendered to. */
export const CASE_PAGES = CASES.map(entry => ({
  path: casePath(entry.id),
  file: entry.id === "001" ? "play.html" : `play-${entry.id}.html`,
}));

export function renderPage(pathname: string): {
  body: string;
  title: string;
  description: string;
  status: number;
  noindex: boolean;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: "http://render.invalid/api/trpc",
        transformer: trpcTransformer,
      }),
    ],
  });
  const wrap = (component: React.ReactNode) =>
    renderToString(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <Router ssrPath={pathname}>{component}</Router>
        </QueryClientProvider>
      </trpc.Provider>
    );
  if (pathname === "/")
    return {
      body: wrap(<Home />),
      title: "BUREAU | An Interrogation Game",
      description:
        "Five suspects, one mole, 12 questions. Every suspect is an AI agent with a story to protect. Catch the lie and name the mole.",
      status: 200,
      noindex: false,
    };
  if (pathname === "/agents")
    return {
      body: wrap(<Agents />),
      title: "BUREAU | Humans vs Agents",
      description:
        "Point your own AI agent at Case 001 through a small HTTP API and see how it does against human players.",
      status: 200,
      noindex: false,
    };
  if (pathname === "/bureau")
    return {
      body: wrap(<Bureau />),
      title: "The Agent Bureau | The File on Every Agent",
      description:
        "One file per AI agent operator across Arc, Base, BNB Chain, Robinhood Chain and Solana, built from outcomes businesses report. Facts with sources, never a score.",
      status: 200,
      noindex: false,
    };
  if (pathname === "/privacy")
    return {
      body: wrap(<Information kind="privacy" />),
      title: "Privacy Notice | The Agent Bureau",
      description:
        "How The Agent Bureau handles game questions, website inquiries, operator access, Bureau files, and privacy questions during the pilot.",
      status: 200,
      noindex: false,
    };
  if (pathname === "/terms")
    return {
      body: wrap(<Information kind="terms" />),
      title: "Site Terms | The Agent Bureau",
      description:
        "What the BUREAU game and the Agent Bureau pilot offer, what Bureau files are and are not, and the limits on how they can be used.",
      status: 200,
      noindex: false,
    };
  const playing = /^\/play(?:\/(\d{3}))?$/.exec(pathname);
  const theCase = playing && findCase(playing[1] ?? "001");
  if (theCase && pathname === casePath(theCase.id))
    return {
      body: wrap(<Play caseId={theCase.id} />),
      title: caseTitle(theCase.id),
      description: caseDescription(theCase.id),
      status: 200,
      noindex: false,
    };
  if (pathname === "/inbox")
    return {
      body: '<main class="section inbox-page"><h1>Private operator inbox</h1><p>Sign in to view your authorized workspace. Customer inquiries are never included in public HTML.</p><a href="/">The Agent Bureau home</a></main>',
      title: "Private Operator Inbox | The Agent Bureau",
      description:
        "Private operator access for reviewing The Agent Bureau website inquiries.",
      status: 200,
      noindex: true,
    };
  return {
    body: wrap(<NotFound />),
    title: "Page Not Found | The Agent Bureau",
    description: "This page could not be found. Return to The Agent Bureau.",
    status: 404,
    noindex: true,
  };
}
export function renderDocument(
  template: string,
  pathname: string,
  origin = "https://theagentbureau.xyz"
) {
  const rendered = renderPage(pathname);
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  // The game pages share as BUREAU with a wide card. Every other page shares
  // as The Agent Bureau, so a game link never previews as a Bureau file.
  const game =
    ["/", "/agents"].includes(pathname) || pathname.startsWith("/play");
  const image = `${origin}${game ? "/og-game.png" : "/bureau-mark.png"}`;
  const tags: [attr: "name" | "property", key: string, value: string][] = [
    ["name", "description", rendered.description],
    ["property", "og:site_name", game ? "BUREAU" : "The Agent Bureau"],
    ["property", "og:title", rendered.title],
    ["property", "og:description", rendered.description],
    ["property", "og:image", image],
    ["name", "twitter:card", game ? "summary_large_image" : "summary"],
    ["name", "twitter:title", rendered.title],
    ["name", "twitter:description", rendered.description],
    ["name", "twitter:image", image],
  ];
  if (game)
    tags.push(
      ["name", "keywords", "interrogation game, detective game, AI game"],
      ["name", "theme-color", "#08111f"]
    );
  let html = template
    .replace('<div id="root"></div>', `<div id="root">${rendered.body}</div>`)
    .replace(/<title>.*?<\/title>/, `<title>${escape(rendered.title)}</title>`);
  // The template's meta tags span several lines, so match any whitespace.
  for (const [attr, key, value] of tags)
    html = html.replace(
      new RegExp(`<meta\\s+${attr}="${key}"\\s+content="[^"]*"\\s*/?>`),
      `<meta ${attr}="${key}" content="${escape(value)}" />`
    );
  if (rendered.noindex)
    html = html.replace(
      "</head>",
      '<meta name="robots" content="noindex, nofollow" /></head>'
    );
  return { html, status: rendered.status };
}
