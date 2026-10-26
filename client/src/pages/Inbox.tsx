import { Header, Footer } from "@/components/SiteChrome";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { startLogin } from "@/const";
import { Loader2, LockKeyhole, RefreshCw } from "lucide-react";
export default function Inbox() {
  const { user, loading } = useAuth();
  const list = trpc.inquiries.list.useQuery(undefined, {
    enabled: !!user && user.role === "admin",
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
        ) : !user ? (
          <div className="access-card">
            <LockKeyhole />
            <h2>Operator sign-in required.</h2>
            <p>
              Customer inquiries are private. Sign in with your Manus account to
              continue.
            </p>
            <button
              className="button button-primary"
              onClick={() => startLogin()}
            >
              Sign in
            </button>
          </div>
        ) : user.role !== "admin" ? (
          <div className="access-card">
            <LockKeyhole />
            <h2>Owner access only.</h2>
            <p>
              Your account is signed in, but it does not have permission to read
              the Bureau inbox.
            </p>
          </div>
        ) : (
          <>
            <div className="inbox-toolbar">
              <p>Saved inquiries from the website form.</p>
              <button className="text-link" onClick={() => list.refetch()}>
                <RefreshCw size={15} />
                Refresh
              </button>
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
