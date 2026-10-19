import type { ApprovalOutcome } from "@mcode/contracts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ApprovalReceipt } from "./types";

/**
 * Mcode builds these choice labels itself, so their receipts read in the past
 * tense. Provider labels such as "Reject always" or "Switch to Bypass" are the
 * provider's own words and stay verbatim.
 */
const MCODE_CHOICE_RECEIPTS: Readonly<Record<string, string>> = {
  "Allow once": "Allowed once",
  "Allow for this session": "Allowed for this session",
  "Always allow": "Always allowed",
  Deny: "Denied",
};

type ReceiptCopy = { label: string; showsSubject: boolean };

const CANCELLED_COPY: Readonly<Record<Extract<ApprovalOutcome, { status: "cancelled" }>["reason"], ReceiptCopy>> = {
  turn_ended: { label: "Cancelled · turn ended", showsSubject: true },
  session_stopped: { label: "Cancelled · session stopped", showsSubject: true },
  unanswerable: { label: "Stopped · Mcode couldn't answer this request", showsSubject: false },
};

const AUTO_DENIED_COPY: Readonly<Record<Extract<ApprovalOutcome, { status: "auto_denied" }>["reason"], ReceiptCopy>> = {
  too_large: { label: "Denied automatically · too large to show", showsSubject: false },
  unreadable: { label: "Denied automatically · Mcode couldn't read this request", showsSubject: false },
};

/** Visible copy for one receipt: the decision label and whether the subject shows beside it. */
export function approvalReceiptCopy(outcome: ApprovalOutcome): ReceiptCopy {
  switch (outcome.status) {
    case "allowed":
    case "denied":
      return { label: MCODE_CHOICE_RECEIPTS[outcome.choiceLabel] ?? outcome.choiceLabel, showsSubject: true };
    case "answered":
      return { label: `Answered ${outcome.count} ${outcome.count === 1 ? "question" : "questions"}`, showsSubject: false };
    case "cancelled":
      return CANCELLED_COPY[outcome.reason];
    case "auto_denied":
      return AUTO_DENIED_COPY[outcome.reason];
  }
}

function isApprovedOutcome(outcome: ApprovalOutcome): boolean {
  return outcome.status === "allowed" || outcome.status === "answered";
}

/** Paper "Decided records" row: a check or cross, the decision, then the subject in mono. */
export function ApprovalReceiptRow({ receipt }: { receipt: ApprovalReceipt }) {
  const { label, showsSubject } = approvalReceiptCopy(receipt.outcome);
  const approved = isApprovedOutcome(receipt.outcome);
  return (
    <div className="flex h-7 min-w-0 max-w-full items-center gap-2 px-2" data-approval-receipt={receipt.requestId}>
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className={`size-3.5 shrink-0 fill-none ${approved ? "stroke-success" : "stroke-muted"}`}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={approved ? "M20 6 9 17l-5-5" : "M18 6 6 18M6 6l12 12"} />
      </svg>
      <span className="min-w-0 max-w-[60%] shrink-0 text-fade whitespace-nowrap text-sm leading-5 text-muted">{label}</span>
      {showsSubject ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="min-w-0 text-fade whitespace-nowrap font-mono text-xs leading-5 text-muted">
                {receipt.subjectLabel}
              </span>
            }
          />
          <TooltipContent>{receipt.subjectLabel}</TooltipContent>
        </Tooltip>
      ) : null}
      {receipt.outcome.status === "denied" && receipt.outcome.note ? (
        <Tooltip>
          <TooltipTrigger
            render={<span className="min-w-0 text-fade whitespace-nowrap text-sm leading-5 text-muted">{receipt.outcome.note}</span>}
          />
          <TooltipContent>{receipt.outcome.note}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
