import type { ReactNode } from "react";
import { Link } from "wouter";

// Header and footer shared by the game pages (/ and /play).
export function GameHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="game-top">
      <Link href="/" className="game-wordmark" aria-label="BUREAU home">
        BUREAU
      </Link>
      {children}
    </header>
  );
}

export function GameFooter() {
  return (
    <footer className="game-foot">
      <span>
        BUREAU is fiction. The suspects are played by Claude, an AI model.
      </span>
      <nav aria-label="Site">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/bureau">The Agent Bureau</Link>
      </nav>
    </footer>
  );
}
