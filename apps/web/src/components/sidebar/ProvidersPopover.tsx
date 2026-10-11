import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/ui/provider-icon";
import type { ProviderBellRow } from "@/features/providers/provider-bell-rows";
import { signInToProvider } from "@/features/providers/sign-in";
import { cn } from "@/lib/utils";

/** Props for {@link ProvidersPopover}. */
interface ProvidersPopoverProps {
  rows: readonly ProviderBellRow[];
}

/** Body of the sidebar Providers popover: a header and one row per provider that needs attention. */
export function ProvidersPopover({ rows }: ProvidersPopoverProps) {
  return (
    <div data-testid="providers-popover">
      <div className="flex h-9 items-center px-2.5 text-button text-ink">Providers</div>
      {rows.length > 0 && (
        <ul>
          {rows.map((row) => <ProviderRow key={row.providerId} row={row} />)}
        </ul>
      )}
    </div>
  );
}

function ProviderRow({ row }: { row: ProviderBellRow }) {
  return (
    <li className="flex items-center gap-2.5 rounded-lg pt-2 pr-1.5 pb-2 pl-2.5">
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        <ProviderIcon provider={row.providerId} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">{row.name}</div>
        <div className={cn("text-xs", row.kind === "signed_out" ? "text-primary" : "text-muted")}>{row.detail}</div>
      </div>
      {row.signInArgv && <SignInPill argv={row.signInArgv} />}
    </li>
  );
}

function SignInPill({ argv }: { argv: readonly string[] }) {
  return (
    <Button variant="subtle" shape="round" className="h-7 px-2.5 text-button" onClick={() => signInToProvider(argv)}>
      Sign in
    </Button>
  );
}
