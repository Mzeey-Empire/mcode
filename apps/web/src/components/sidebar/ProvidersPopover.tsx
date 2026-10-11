import type { ReactNode } from "react";
import type { ProviderId } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { Spinner } from "@/components/ui/spinner";
import type { ProviderBellCliUpdate, ProviderBellRow } from "@/features/providers/provider-bell-rows";
import { cn } from "@/lib/utils";

/** Props for {@link ProvidersPopover}. */
interface ProvidersPopoverProps {
  rows: readonly ProviderBellRow[];
  onSignIn: (argv: readonly string[]) => void;
  onUpdateCli: (providerId: ProviderId) => void;
  onTry: (providerId: ProviderId, modelId: string) => void;
}

/** Body of the sidebar Providers popover: a header and one row per provider that needs attention. */
export function ProvidersPopover({ rows, ...actions }: ProvidersPopoverProps) {
  return (
    <div data-testid="providers-popover">
      <div className="flex h-9 items-center px-2.5 text-button text-ink">Providers</div>
      {rows.length > 0 && (
        <ul>
          {rows.map((row) => <ProviderRow key={row.providerId} row={row} {...actions} />)}
        </ul>
      )}
    </div>
  );
}

type RowProps = { row: ProviderBellRow } & Omit<ProvidersPopoverProps, "rows">;

function ProviderRow({ row, ...actions }: RowProps) {
  return (
    <li className="flex items-center gap-2.5 rounded-lg pt-2 pr-1.5 pb-2 pl-2.5">
      <span className="flex h-5 w-4 shrink-0 items-center justify-center self-start">
        <ProviderIcon provider={row.providerId} size={16} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-sm font-medium text-ink">{row.name}</div>
        <RowDetail row={row} />
      </div>
      <RowAction row={row} {...actions} />
    </li>
  );
}

function RowDetail({ row }: { row: ProviderBellRow }) {
  if (row.kind === "cli_update") return <CliUpdateDetail installed={row.installed} update={row.update} />;
  return <div className={cn("text-fade text-xs", row.kind === "signed_out" ? "text-primary" : "text-muted")}>{row.detail}</div>;
}

function CliUpdateDetail({ installed, update }: { installed: string | null; update: ProviderBellCliUpdate }) {
  if (update.state === "failed") return <div className="text-xs break-words text-muted">{update.reason}</div>;
  if (update.state === "running") {
    return <DetailLine><span>Updating to</span><Version value={update.target} /></DetailLine>;
  }
  return (
    <DetailLine>
      <span>CLI</span>
      <Version value={update.target} />
      <span>{installed ? "available · you have" : "available"}</span>
      {installed && <Version value={installed} />}
    </DetailLine>
  );
}

function DetailLine({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-x-1.5 text-xs text-muted">{children}</div>;
}

function Version({ value }: { value: string }) {
  return <span className="font-mono">{value}</span>;
}

function RowAction({ row, onSignIn, onUpdateCli, onTry }: RowProps) {
  if (row.kind === "signed_out") return <ActionPill label="Sign in" onClick={() => onSignIn(row.signInArgv)} />;
  if (row.kind === "new_model") return <ActionPill label="Try" onClick={() => onTry(row.providerId, row.tryModelId)} />;
  if (row.kind !== "cli_update") return null;
  if (row.update.state === "running") {
    return (
      <span className="flex size-7 shrink-0 items-center justify-center">
        <Spinner size={16} aria-label={`Updating ${row.name} CLI`} />
      </span>
    );
  }
  return (
    <ActionPill
      label={row.update.state === "failed" ? "Retry" : "Update"}
      onClick={() => onUpdateCli(row.providerId)}
    />
  );
}

function ActionPill({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="subtle" shape="round" className="h-7 shrink-0 px-2.5 text-[1.3rem]/[1.8rem] font-medium" onClick={onClick}>
      {label}
    </Button>
  );
}
