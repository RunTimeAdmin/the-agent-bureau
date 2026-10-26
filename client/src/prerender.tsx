import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { Router } from "wouter";
import { trpc } from "./lib/trpc";
import Home from "./pages/Home";
import Information from "./pages/Information";
import NotFound from "./pages/NotFound";
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
        transformer: superjson,
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
      title: "The Agent Bureau | Intelligence on Assignment",
      description:
        "Specialist agents, clear scope, and human accountability. Explore AI security, identity, software inventory, and provenance capabilities at The Agent Bureau.",
      status: 200,
      noindex: false,
    };
  if (pathname === "/privacy")
    return {
      body: wrap(<Information kind="privacy" />),
      title: "Privacy Notice | The Agent Bureau",
      description:
        "How The Agent Bureau handles website inquiries, contact information, operator access, and privacy questions during early access.",
      status: 200,
      noindex: false,
    };
  if (pathname === "/terms")
    return {
      body: wrap(<Information kind="terms" />),
      title: "Site Terms and Early Access | The Agent Bureau",
      description:
        "Understand proposed capabilities, inquiry-only engagement, illustrative content, and the boundaries of The Agent Bureau early-access website.",
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
export function renderDocument(template: string, pathname: string) {
  const rendered = renderPage(pathname);
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  let html = template
    .replace('<div id="root"></div>', `<div id="root">${rendered.body}</div>`)
    .replace(/<title>.*?<\/title>/, `<title>${escape(rendered.title)}</title>`)
    .replace(
      /<meta name="description" content="[^"]*"\s*\/?\s*>/,
      `<meta name="description" content="${escape(rendered.description)}" />`
    )
    .replace(
      /<meta property="og:title" content="[^"]*"\s*\/?\s*>/,
      `<meta property="og:title" content="${escape(rendered.title)}" />`
    )
    .replace(
      /<meta property="og:description" content="[^"]*"\s*\/?\s*>/,
      `<meta property="og:description" content="${escape(rendered.description)}" />`
    )
    .replace(
      /<meta name="twitter:title" content="[^"]*"\s*\/?\s*>/,
      `<meta name="twitter:title" content="${escape(rendered.title)}" />`
    )
    .replace(
      /<meta name="twitter:description" content="[^"]*"\s*\/?\s*>/,
      `<meta name="twitter:description" content="${escape(rendered.description)}" />`
    );
  if (rendered.noindex)
    html = html.replace(
      "</head>",
      '<meta name="robots" content="noindex, nofollow" /></head>'
    );
  return { html, status: rendered.status };
}
