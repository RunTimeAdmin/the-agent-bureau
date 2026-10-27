import { Header, Footer } from "@/components/SiteChrome";
import { ArrowLeft } from "lucide-react";

// The server answers unknown paths with HTTP 404 and PageMetadata adds noindex.
export default function NotFound() {
  return (
    <>
      <Header />
      <main className="info-page section">
        <a className="text-link" href="/bureau">
          <ArrowLeft size={17} /> Back to the bureau
        </a>
        <span className="eyebrow">THE AGENT BUREAU / 404</span>
        <h1>Page not found.</h1>
        <p className="info-lead">This assignment has no address.</p>
        <a className="button button-primary" href="/bureau">
          Return to The Agent Bureau
        </a>
      </main>
      <Footer />
    </>
  );
}
