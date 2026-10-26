import { useEffect, useState } from "react";
import { ArrowUpRight, Check, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Interest } from "@/lib/bureau";
const interests: Interest[] = [
  "Hire an agent",
  "Become a provider",
  "Partnership",
  "General inquiry",
];
export default function ContactForm() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    interest: "Hire an agent" as Interest,
    message: "",
    website: "",
  });
  const [consent, setConsent] = useState(false);
  const submit = trpc.inquiries.submit.useMutation();
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (
        event as CustomEvent<{ interest: Interest; message: string }>
      ).detail;
      setForm(current => ({ ...current, ...detail }));
      submit.reset();
    };
    window.addEventListener("bureau-inquiry", listener);
    return () => window.removeEventListener("bureau-inquiry", listener);
  }, []);
  if (submit.isSuccess)
    return (
      <div className="form-success" role="status">
        <span className="success-icon">
          <Check size={30} />
        </span>
        <span className="mini-label">INQUIRY RECORDED</span>
        <h3>Your brief is on file.</h3>
        <p>
          Thanks, {form.name.split(" ")[0]}. Your inquiry has been saved for the
          Bureau team to review. This is an inquiry, not a confirmed booking.
        </p>
        <div className="reference">
          REFERENCE <strong>{submit.data.reference}</strong>
        </div>
        <button
          className="text-link"
          onClick={() => {
            submit.reset();
            setForm({
              name: "",
              email: "",
              interest: "Hire an agent",
              message: "",
              website: "",
            });
            setConsent(false);
          }}
        >
          Send another inquiry <ArrowUpRight size={16} />
        </button>
      </div>
    );
  return (
    <form
      className="inquiry-form"
      onSubmit={event => {
        event.preventDefault();
        if (consent) submit.mutate(form);
      }}
    >
      <div className="form-row">
        <label>
          Your name
          <input
            autoComplete="name"
            required
            minLength={2}
            maxLength={120}
            value={form.name}
            onChange={event => setForm({ ...form, name: event.target.value })}
            placeholder="Alex Morgan"
          />
        </label>
        <label>
          Email address
          <input
            type="email"
            autoComplete="email"
            required
            maxLength={320}
            value={form.email}
            onChange={event => setForm({ ...form, email: event.target.value })}
            placeholder="alex@yourcompany.com"
          />
        </label>
      </div>
      <label>
        I'm here to
        <select
          value={form.interest}
          onChange={event =>
            setForm({ ...form, interest: event.target.value as Interest })
          }
        >
          {interests.map(interest => (
            <option key={interest}>{interest}</option>
          ))}
        </select>
      </label>
      <label>
        The brief
        <textarea
          required
          minLength={20}
          maxLength={4000}
          rows={4}
          value={form.message}
          onChange={event => setForm({ ...form, message: event.target.value })}
          placeholder="What do you need done? Tell us about the outcome, your environment, and any constraints."
        />
      </label>
      <div className="honeypot" aria-hidden="true">
        <label>
          Website
          <input
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={form.website}
            onChange={event =>
              setForm({ ...form, website: event.target.value })
            }
          />
        </label>
      </div>
      <label className="consent">
        <input
          type="checkbox"
          required
          checked={consent}
          onChange={event => setConsent(event.target.checked)}
        />
        <span>
          I agree to be contacted about this inquiry. I've read the{" "}
          <a href="/privacy">privacy notice</a>.
        </span>
      </label>
      {submit.isError && (
        <p className="form-error" role="alert">
          {submit.error.message ||
            "Your inquiry could not be saved. Please try again."}
        </p>
      )}
      <div className="form-submit-row">
        <button
          className="button button-primary"
          type="submit"
          disabled={submit.isPending}
        >
          {submit.isPending ? (
            <>
              <Loader2 size={17} className="spin" />
              Saving your brief
            </>
          ) : (
            <>
              Send the brief <ArrowUpRight size={18} />
            </>
          )}
        </button>
        <span>
          No credentials. No payment.
          <br />
          Just the right starting point.
        </span>
      </div>
    </form>
  );
}
