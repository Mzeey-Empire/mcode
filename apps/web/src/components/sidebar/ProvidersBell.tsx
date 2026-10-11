import { Bell } from "lucide-react";
import { useState } from "react";
import { IconButton } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { deriveProviderBellRows } from "@/features/providers/provider-bell-rows";
import { signInToProvider } from "@/features/providers/sign-in";
import { useProviderStatusStore } from "@/stores/providerStatusStore";
import { ProvidersPopover } from "./ProvidersPopover";

/**
 * Sidebar footer bell for provider sign-in and rate-limit problems. A dot marks
 * that at least one provider needs attention. Opening it re-reads status
 * through the server's cache, or re-checks while a provider reads signed out.
 * It never fetches usage.
 */
export function ProvidersBell() {
  const [open, setOpen] = useState(false);
  const statuses = useProviderStatusStore((s) => s.statuses);
  const fetchStatus = useProviderStatusStore((s) => s.fetch);
  const rows = deriveProviderBellRows(statuses, new Date());
  // A signed-out row bypasses the cache, so a sign-in done outside Mcode clears on the next open
  // instead of after the 10 minute cache.
  const hasSignedOut = rows.some((row) => row.kind === "signed_out");
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) void fetchStatus(hasSignedOut);
      }}
    >
      <PopoverTrigger render={<IconButton aria-label="Providers" />}>
        <Bell strokeWidth={1.5} aria-hidden />
        {rows.length > 0 && (
          <span
            aria-hidden
            data-testid="providers-bell-dot"
            className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary"
          />
        )}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-95 rounded-dialog p-1.5">
        <ProvidersPopover
          rows={rows}
          onSignIn={(argv) => {
            setOpen(false);
            signInToProvider(argv);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
