import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import PageMetadata from "./components/PageMetadata";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
const Bureau = lazy(() => import("./pages/Bureau"));
const Information = lazy(() => import("./pages/Information"));
const Inbox = lazy(() => import("./pages/Inbox"));
const Play = lazy(() => import("./pages/Play"));
const Agents = lazy(() => import("./pages/Agents"));
export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <PageMetadata />
          <Suspense
            fallback={
              <main className="section" role="status">
                Opening the bureau…
              </main>
            }
          >
            <Switch>
              <Route path="/" component={Home} />
              <Route path="/bureau" component={Bureau} />
              <Route path="/privacy">
                {() => <Information kind="privacy" />}
              </Route>
              <Route path="/terms">{() => <Information kind="terms" />}</Route>
              <Route path="/inbox" component={Inbox} />
              <Route path="/play">{() => <Play />}</Route>
              <Route path="/play/:caseId">
                {params => <Play caseId={params.caseId} />}
              </Route>
              <Route path="/agents" component={Agents} />
              <Route path="/404" component={NotFound} />
              <Route component={NotFound} />
            </Switch>
          </Suspense>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
