import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { Link } from "wouter";
import { FURNISH_TOOL_URL } from "@/lib/bureau";
export function BureauMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand ${small ? "brand-small" : ""}`}>
      <svg viewBox="0 0 40 44" aria-hidden="true">
        <path
          d="M3 3h17l14 10-14 9H3V3Zm0 21h17l14 9-14 9H3V24Z"
          fill="currentColor"
        />
        <path d="M10 10h7l6 3-6 3h-7zm0 20h7l6 3-6 3h-7z" fill="#111714" />
      </svg>
      <span>
        THE AGENT
        <br />
        BUREAU
      </span>
    </span>
  );
}
const links = [
  { label: "The file", href: "/#file" },
  { label: "For furnishers", href: "/#furnish" },
  { label: "Rules", href: "/#rules" },
  { label: "How it works", href: "/#how" },
];
export function Header() {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [open]);
  return (
    <header className="site-header">
      <div className="nav-inner">
        <Link href="/" aria-label="The Agent Bureau home">
          <BureauMark />
        </Link>
        <nav
          id="bureau-main-navigation"
          aria-label="Main navigation"
          className={open ? "nav-links is-open" : "nav-links"}
        >
          {links.map(link => (
            <a href={link.href} key={link.href} onClick={() => setOpen(false)}>
              {link.label}
            </a>
          ))}
          <a
            className="nav-cta"
            href="/#contact"
            onClick={() => setOpen(false)}
          >
            Join the pilot <ArrowUpRight size={15} />
          </a>
        </nav>
        <button
          ref={toggle}
          className="mobile-menu"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls="bureau-main-navigation"
          onClick={() => setOpen(!open)}
        >
          {open ? <X /> : <Menu />}
        </button>
      </div>
    </header>
  );
}
export function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-top">
        <Link href="/" aria-label="The Agent Bureau home">
          <BureauMark />
        </Link>
        <p>
          The file on every agent.
          <br />
          <span>Facts with sources. Never a score.</span>
        </p>
        <a href="/#contact" className="footer-contact">
          Start a conversation <ArrowUpRight size={20} />
        </a>
      </div>
      <div className="footer-bottom">
        <span>© {new Date().getFullYear()} The Agent Bureau</span>
        <span className="footer-status">
          <i /> Pilot, 2026
        </span>
        <div>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Site terms</Link>
          <a href={FURNISH_TOOL_URL} target="_blank" rel="noreferrer">
            Signing tool
          </a>
          <Link href="/inbox">Operator access</Link>
        </div>
      </div>
    </footer>
  );
}
