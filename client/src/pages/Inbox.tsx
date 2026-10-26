import { useState } from "react";
import { Header, Footer } from "@/components/SiteChrome";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Loader2, LockKeyhole, LogOut, RefreshCw, Trash2 } from "lucide-react";
type Status = "new" | "reviewed" | "closed";
type Filter = "open" | "closed" | "all";
const STATUS_LABELS: Record<Status, string> = {
  new: "New",
  reviewed: "Reviewed",
  closed: "Closed",
};
const FILTERS: { key: Filter; label: string; match: (status: Status) => boolean }[] = [
  { key: "open", label: "Open", match: status => status !== "closed" },
  { key: "closed", label: "Closed", match: status => status === "closed" },
  { key: "all", label: "All", match: () => true },
];
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
  const [filter, setFilter] = useState<Filter>("open");
  // Announced in a live region, so it survives a card leaving the view.
  const [notice, setNotice] = useState("");
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const items = list.data ?? [];
  const referenceFor = (id: number) =>
    items.find(item => item.id === id)?.reference ?? "The inquiry";
  const update = trpc.inquiries.setStatus.useMutation({
    onSuccess: (_result, { id, status }) => {
      const current = FILTERS.find(entry => entry.key === filter)!;
      const moved = current.match(status)
        ? ""
        : ` Find it under ${status === "closed" ? "Closed" : "Open"}.`;
      setNotice(
        `Saved. ${referenceFor(id)} is now ${STATUS_LABELS[status]}.${moved}`
      );
      return utils.inquiries.list.invalidate();
    },
  });
  const remove = trpc.inquiries.remove.useMutation({
    onSuccess: (_result, { id }) => {
      setConfirmingId(null);
      setNotice(`Deleted ${referenceFor(id)}.`);
      return utils.inquiries.list.invalidate();
    },
  });
  const activeFilter = FILTERS.find(entry => entry.key === filter)!;
  const visible = items.filter(item => activeFilter.match(item.status));
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
            {items.length > 0 && (
              <div
                className="category-tabs inbox-filters"
                role="group"
                aria-label="Filter inquiries"
              >
                {FILTERS.map(entry => (
                  <button
                    key={entry.key}
                    className={filter === entry.key ? "selected" : ""}
                    aria-pressed={filter === entry.key}
                    onClick={() => {
                      setFilter(entry.key);
                      setNotice("");
                      setConfirmingId(null);
                    }}
                  >
                    {entry.label} ·{" "}
                    {items.filter(item => entry.match(item.status)).length}
                  </button>
                ))}
              </div>
            )}
            <p className="inbox-notice" role="status" aria-live="polite">
              {notice}
            </p>
            {(update.isError || remove.isError) && (
              <p className="form-error" role="alert">
                {(update.error ?? remove.error)?.message}
              </p>
            )}
            {list.isLoading ? (
              <p>Loading inquiries…</p>
            ) : list.isError ? (
              <p className="form-error" role="alert">
                {list.error.message}
              </p>
            ) : !items.length ? (
              <div className="access-card">
                <h2>No inquiries yet.</h2>
                <p>
                  Real submissions will appear here. No sample customer data has
                  been seeded.
                </p>
              </div>
            ) : !visible.length ? (
              <div className="access-card">
                <h2>No {activeFilter.label.toLowerCase()} inquiries.</h2>
              </div>
            ) : (
              <div className="inquiry-list">
                {visible.map(item => (
                  <article className="inbox-card" key={item.id}>
                    <div className="inbox-card-head">
                      <span className="mini-label">
                        {item.reference} / {item.interest}
                      </span>
                      <select
                        aria-label={`Status for ${item.reference}`}
                        value={item.status}
                        disabled={update.isPending || remove.isPending}
                        onChange={event =>
                          update.mutate({
                            id: item.id,
                            status: event.target.value as Status,
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
                    <div className="inbox-card-foot">
                      <small>{new Date(item.createdAt).toLocaleString()}</small>
                      {confirmingId === item.id ? (
                        <span className="inbox-confirm">
                          <span>Delete permanently?</span>
                          <button
                            className="text-link danger"
                            onClick={() => remove.mutate({ id: item.id })}
                            disabled={remove.isPending}
                          >
                            {remove.isPending ? (
                              <Loader2 size={14} className="spin" />
                            ) : null}
                            Confirm delete
                          </button>
                          <button
                            className="text-link"
                            onClick={() => setConfirmingId(null)}
                            disabled={remove.isPending}
                            autoFocus
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          className="text-link muted"
                          onClick={() => setConfirmingId(item.id)}
                          aria-label={`Delete ${item.reference}`}
                          disabled={remove.isPending}
                        >
                          <Trash2 size={14} />
                          Delete
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </main>
      <Footer />
    </>
  );
}
