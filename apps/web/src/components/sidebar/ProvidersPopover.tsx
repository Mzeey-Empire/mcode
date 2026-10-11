import type { ProviderId } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/ui/provider-icon";
import type { ProviderBellRow } from "@/features/providers/provider-bell-rows";
import { cn } from "@/lib/utils";

/** Props for {@link ProvidersPopover}. */
interface ProvidersPopoverProps {
  rows: readonly ProviderBellRow[];
  onSignIn: (argv: readonly string[]) => void;
  onTry: (providerId: ProviderId, modelId: string) => void;
}

/** Body of the sidebar Providers popover: a header and one row per provider that needs attention. */
export function ProvidersPopover({ rows, onSignIn, onTry }: ProvidersPopoverProps) {
  return (
    <div data-testid="providers-popover">
      <div className="flex h-9 items-center px-2.5 text-button text-ink">Providers</div>
      {rows.length > 0 && (
        <ul>
          {rows.map((row) => <ProviderRow key={row.providerId} row={row} onSignIn={onSignIn} onTry={onTry} />)}
        </ul>
      )}
    </div>
  );
}

function ProviderRow({ row, onSignIn, onTry }: { row: ProviderBellRow } & Omit<ProvidersPopoverProps, "rows">) {
  const { signInArgv, tryModelId } = row;
  return (
    <li className="flex items-center gap-2.5 rounded-lg pt-2 pr-1.5 pb-2 pl-2.5">
      <span className="flex h-5 w-4 shrink-0 items-center justify-center self-start">
        <ProviderIcon provider={row.providerId} size={16} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-sm font-medium text-ink">{row.name}</div>
        <div className={cn("text-fade text-xs", row.kind === "signed_out" ? "text-primary" : "text-muted")}>{row.detail}</div>
      </div>
      {signInArgv && <RowPill label="Sign in" onClick={() => onSignIn(signInArgv)} />}
      {tryModelId && <RowPill label="Try" onClick={() => onTry(row.providerId, tryModelId)} />}
    </li>
  );
}

function RowPill({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="subtle" shape="round" className="h-7 px-2.5 text-button" onClick={onClick}>
      {label}
    </Button>
  );
}
