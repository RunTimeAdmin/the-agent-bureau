import { useState } from "react";
import { Header, Footer } from "@/components/SiteChrome";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Loader2, LockKeyhole, LogOut, RefreshCw } from "lucide-react";
function SignIn() {
  const { loginConfigured, login, loginPending, loginError } = useAuth();
  const [password, setPassword] = useState("");
  if (!loginConfigured)
    return (
      <div className="access-card">
        <LockKeyhole />
        <h2>Operator sign-in is not set up.</h2>
        <p>
          Set OPERATOR_PASSWORD and SESSION_SECRET on the server, then restart
          it. See DEPLOYMENT.md.
        </p>
      </div>
    );
  return (
    <div className="access-card">
      <LockKeyhole />
      <h2>Operator sign-in required.</h2>
      <p>Customer inquiries are private. Enter the operator password.</p>
      <form
        className="inquiry-form operator-sign-in"
        onSubmit={event => {
          event.preventDefault();
          login(password);
        }}
      >
        <label>
          Operator password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={event => setPassword(event.target.value)}
          />
        </label>
        {loginError && (
          <p className="form-error" role="alert">
            {loginError}
          </p>
        )}
        <button
          className="button button-primary"
          type="submit"
          disabled={loginPending}
        >
          {loginPending ? <Loader2 size={17} className="spin" /> : null}
          Sign in
        </button>
      </form>
    </div>
  );
}
export default function Inbox() {
  const { isOperator, loading, logout, logoutPending } = useAuth();
  const list = trpc.inquiries.list.useQuery(undefined, {
    enabled: isOperator,
    retry: false,
  });
  const utils = trpc.useUtils();
  const update = trpc.inquiries.setStatus.useMutation({
    onSuccess: () => utils.inquiries.list.invalidate(),
  });
  return (
    <>
      <Header />
      <main className="section inbox-page">
        <span className="eyebrow">PRIVATE / OPERATOR WORKSPACE</span>
        <h1>Inquiry inbox.</h1>
        {loading ? (
          <p className="loading-state">
            <Loader2 className="spin" /> Checking your session
          </p>
        ) : !isOperator ? (
          <SignIn />
        ) : (
          <>
            <div className="inbox-toolbar">
              <p>Saved inquiries from the website form.</p>
              <div className="inbox-actions">
                <button className="text-link" onClick={() => list.refetch()}>
                  <RefreshCw size={15} />
                  Refresh
                </button>
                <button
                  className="text-link"
                  onClick={logout}
                  disabled={logoutPending}
                >
                  <LogOut size={15} />
                  Sign out
                </button>
              </div>
            </div>
            {list.isLoading ? (
              <p>Loading inquiries…</p>
            ) : list.isError ? (
              <p className="form-error" role="alert">
                {list.error.message}
              </p>
            ) : !list.data?.length ? (
              <div className="access-card">
                <h2>No inquiries yet.</h2>
                <p>
                  Real submissions will appear here. No sample customer data has
                  been seeded.
                </p>
              </div>
            ) : (
              <div className="inquiry-list">
                {list.data.map(item => (
                  <article className="inbox-card" key={item.id}>
                    <div className="inbox-card-head">
                      <span className="mini-label">
                        {item.reference} / {item.interest}
                      </span>
                      <select
                        aria-label={`Status for ${item.reference}`}
                        value={item.status}
                        disabled={update.isPending}
                        onChange={event =>
                          update.mutate({
                            id: item.id,
                            status: event.target.value as
                              | "new"
                              | "reviewed"
                              | "closed",
                          })
                        }
                      >
                        <option value="new">New</option>
                        <option value="reviewed">Reviewed</option>
                        <option value="closed">Closed</option>
                      </select>
                    </div>
                    <h2>{item.name}</h2>
                    <a href={`mailto:${item.email}`}>{item.email}</a>
                    <p className="inbox-message">{item.message}</p>
                    <small>{new Date(item.createdAt).toLocaleString()}</small>
                  </article>
                ))}
              </div>
            )}
            {update.isError && (
              <p className="form-error" role="alert">
                {update.error.message}
              </p>
            )}
          </>
        )}
      </main>
      <Footer />
    </>
  );
}
