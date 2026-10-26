import { ArrowUpRight, Check, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Service, startInquiry } from "@/lib/bureau";
export default function ServiceDialog({
  service,
  onClose,
}: {
  service: Service | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={!!service}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="bureau-dialog">
        {service && (
          <>
            <span className="mini-label">{service.code} / PILOT SERVICE</span>
            <DialogTitle>{service.title}</DialogTitle>
            <DialogDescription>{service.description}</DialogDescription>
            <div className="dialog-section">
              <h4>What you receive</h4>
              {service.output.map(item => (
                <p className="output-line" key={item}>
                  <Check size={15} />
                  {item}
                </p>
              ))}
            </div>
            <div className="dialog-section">
              <h4>What we need</h4>
              <p>{service.inputs}</p>
            </div>
            <div className="scope-note">
              <ShieldCheck size={20} />
              <p>{service.exclusions}</p>
            </div>
            <p className="small-note">
              Pricing, provider availability, delivery date, and review terms
              are confirmed before any engagement. No payment is taken on this
              website.
            </p>
            <button
              className="button button-primary"
              onClick={() => {
                onClose();
                setTimeout(
                  () =>
                    startInquiry(
                      "Hire an agent",
                      `I'd like to discuss ${service.title}.\n\nMy desired outcome is: `
                    ),
                  100
                );
              }}
            >
              Request this capability <ArrowUpRight size={17} />
            </button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
