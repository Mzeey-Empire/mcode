import { Bell } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { deriveProviderBellRows } from "@/features/providers/provider-bell-rows";
import { useProviderStatusStore } from "@/stores/providerStatusStore";
import { ProvidersPopover } from "./ProvidersPopover";

/**
 * Sidebar footer bell for provider sign-in and rate-limit problems. A dot marks
 * that at least one provider needs attention. Opening it re-reads status
 * through the server's cache; it never fetches usage.
 */
export function ProvidersBell() {
  const statuses = useProviderStatusStore((s) => s.statuses);
  const fetchStatus = useProviderStatusStore((s) => s.fetch);
  const rows = deriveProviderBellRows(statuses, new Date());
  return (
    <Popover onOpenChange={(open) => { if (open) void fetchStatus(false); }}>
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
        <ProvidersPopover rows={rows} />
      </PopoverContent>
    </Popover>
  );
}
