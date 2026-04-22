import { useState, useEffect, useRef, useCallback, type ComponentType } from "react";
import { ChevronDown, ChevronRight, Lock, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatContextWindow } from "./format-context-window";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  MODEL_PROVIDERS,
  findModelById,
  type ModelProvider,
} from "@/lib/model-registry";
import { getTransport } from "@/transport";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import {
  ClaudeIcon,
  CodexIcon,
  CursorProviderIcon,
  OpenCodeIcon,
  GeminiIcon,
  CopilotIcon,
} from "./ProviderIcons";

type IconComponent = ComponentType<{ size?: number; className?: string }>;

const PROVIDER_META: Record<string, { icon: IconComponent; color: string }> = {
  claude: { icon: ClaudeIcon, color: "text-orange-500 dark:text-orange-400" },
  codex: { icon: CodexIcon, color: "text-emerald-400" },
  copilot: { icon: CopilotIcon, color: "text-violet-400 dark:text-violet-300" },
  cursor: { icon: CursorProviderIcon, color: "text-blue-400" },
  opencode: { icon: OpenCodeIcon, color: "text-violet-400" },
  gemini: { icon: GeminiIcon, color: "text-sky-400" },
};

interface ModelSelectorProps {
  selectedModelId: string;
  /**
   * Explicit provider ID for the selected model. Required when multiple
   * providers share the same model ID (e.g. "gpt-5.3-codex" exists in both
   * Codex and Copilot). Without this, the selector cannot determine which
   * provider's icon/label to show, and the wrong provider may be committed.
   */
  selectedProviderId?: string;
  /** Called with both the model ID and the provider it was selected from. */
  onSelect: (modelId: string, providerId: string) => void;
  /** Fully locked: no changes allowed (agent running) */
  locked: boolean;
  /** Provider locked: can switch models within the same provider but not change provider (thread started) */
  providerLocked?: boolean;
}

/** Renders a model selection dropdown and controls selection state. */
export function ModelSelector({ selectedModelId, selectedProviderId, onSelect, locked, providerLocked }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read the full list once at the top level -- hooks cannot be called inside .map().
  const availabilityList = useProviderAvailabilityStore((s) => s.providers);

  // Dynamically fetched model lists, keyed by provider ID.
  const [dynamicModels, setDynamicModels] = useState<Map<string, ModelProvider["models"]>>(new Map());
  const dynamicModelsRef = useRef<Map<string, ModelProvider["models"]>>(new Map());
  const [loadingProviders, setLoadingProviders] = useState<Set<string>>(new Set());
  const fetchingRef = useRef<Set<string>>(new Set());
  /** Timestamps of the last failed fetch per provider, used to enforce a retry cooldown. */
  const fetchFailedAtRef = useRef<Map<string, number>>(new Map());
  /** How long to wait before retrying a provider after a failed fetch. */
  const FETCH_RETRY_COOLDOWN_MS = 30_000;

  /** Fetches live models for a provider and caches the result. No-ops while a fetch is in-flight, the cache is populated, or within the retry cooldown after a failure. */
  const fetchProviderModels = useCallback(async (providerId: string) => {
    const lastFailedAt = fetchFailedAtRef.current.get(providerId);
    if (
      fetchingRef.current.has(providerId) ||
      dynamicModelsRef.current.has(providerId) ||
      (lastFailedAt !== undefined && Date.now() - lastFailedAt < FETCH_RETRY_COOLDOWN_MS)
    ) return;
    fetchingRef.current.add(providerId);
    setLoadingProviders((prev) => new Set(prev).add(providerId));
    try {
      const info = await getTransport().listProviderModels(providerId);
      const mapped: ModelProvider["models"] = info.map((m) => ({
        id: m.id,
        label: m.name,
        providerId,
        group: m.group,
        contextWindow: m.contextWindow,
        multiplier: m.multiplier,
      }));
      const updated = new Map(dynamicModelsRef.current).set(providerId, mapped);
      dynamicModelsRef.current = updated;
      setDynamicModels(updated);
    } catch {
      // Record failure time so retries are throttled — leave the cache unpopulated
      // so a subsequent hover after the cooldown triggers a fresh attempt.
      fetchFailedAtRef.current.set(providerId, Date.now());
    } finally {
      fetchingRef.current.delete(providerId);
      setLoadingProviders((prev) => {
        const next = new Set(prev);
        next.delete(providerId);
        return next;
      });
    }
  }, []);

  /** Returns live models for a provider, falling back to the static registry. */
  const getModels = (p: ModelProvider): ModelProvider["models"] =>
    dynamicModels.get(p.id) ?? p.models;

  // Delayed hover close so user has time to move to submenu
  const setHoveredWithDelay = (providerId: string | null) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (providerId) {
      setHoveredProvider(providerId);
    } else {
      hoverTimeoutRef.current = setTimeout(() => {
        setHoveredProvider(null);
      }, 300);
    }
  };

  const model = findModelById(selectedModelId);
  const normalizedSelectedId = model?.id ?? selectedModelId;

  // Resolve display provider: prefer the explicit selectedProviderId so that
  // providers sharing the same model ID (e.g. Codex vs Copilot) show correctly.
  const displayProvider = selectedProviderId
    ? MODEL_PROVIDERS.find((p) => p.id === selectedProviderId)
    : MODEL_PROVIDERS.find((p) => p.models.some((m) => m.id === normalizedSelectedId));

  const meta = displayProvider ? PROVIDER_META[displayProvider.id] : undefined;
  const Icon = meta?.icon ?? ClaudeIcon;
  const iconClass = meta?.color ?? "";
  const shortLabel = model && displayProvider
    ? model.label.replace(`${displayProvider.name} `, "")
    : (model?.label ?? selectedModelId);

  // For a provider-locked thread, fetch immediately so the list is current.
  useEffect(() => {
    if (providerLocked && displayProvider?.supportsModelListing) {
      fetchProviderModels(displayProvider.id);
    }
  }, [providerLocked, displayProvider?.id, displayProvider?.supportsModelListing, fetchProviderModels]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setHoveredProvider(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  if (locked) {
    return (
      <span className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
        <Icon size={12} className={iconClass} />
        {shortLabel}
        <Lock size={10} className="ml-0.5 opacity-75" />
      </span>
    );
  }

  const handleSelectModel = (modelId: string, providerId: string) => {
    onSelect(modelId, providerId);
    setOpen(false);
    setHoveredProvider(null);
  };

  /** Groups a provider's models by their `group` field. Returns ungrouped if none use it. */
  const groupModels = (models: ModelProvider["models"]) => {
    const hasGroups = models.some((m) => m.group);
    if (!hasGroups) return null;
    const seen = new Map<string, typeof models>();
    for (const m of models) {
      const g = m.group ?? "";
      if (!seen.has(g)) seen.set(g, []);
      seen.get(g)!.push(m);
    }
    const result: { label: string; models: typeof models }[] = [];
    seen.forEach((ms, label) => result.push({ label, models: ms }));
    return result;
  };

  const renderModelRow = (
    m: ModelProvider["models"][0],
    providerId: string,
    isSelected: (id: string) => boolean
  ) => {
    const ctxLabel = formatContextWindow(m.contextWindow);
    return (
      <button
        key={m.id}
        onClick={() => handleSelectModel(m.id, providerId)}
        className={cn(
          "flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs",
          isSelected(m.id)
            ? "bg-accent text-foreground"
            : "text-popover-foreground hover:bg-accent/50 hover:text-foreground"
        )}
      >
        <span className="flex-1 text-left">{m.label}</span>
        {ctxLabel && (
          <span className="text-[10px] text-muted-foreground/60 tabular-nums">
            {ctxLabel}
          </span>
        )}
        {m.multiplier != null && (
          <span className="text-[10px] text-muted-foreground/60 tabular-nums">
            {m.multiplier}x
          </span>
        )}
        {isSelected(m.id) && (
          <Check size={10} className="shrink-0 text-foreground" />
        )}
      </button>
    );
  };

  const renderGroupedModels = (
    models: ModelProvider["models"],
    providerId: string,
    isSelected: (id: string) => boolean
  ) => {
    const groups = groupModels(models);
    if (!groups) {
      return models.map((m) => renderModelRow(m, providerId, isSelected));
    }
    return groups.map(({ label, models: gModels }) => (
      <div key={label}>
        <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 select-none">
          {label}
        </div>
        {gModels.map((m) => renderModelRow(m, providerId, isSelected))}
      </div>
    ));
  };

  const renderSubmenu = (p: ModelProvider) => {
    // A model row is "selected" only when both ID and provider match.
    const isSelected = (modelId: string) =>
      modelId === normalizedSelectedId && p.id === (selectedProviderId ?? displayProvider?.id);

    return (
      <div
        className="absolute left-full bottom-0 -ml-1 pl-2 min-w-[180px]"
        onMouseEnter={() => setHoveredWithDelay(p.id)}
        onMouseLeave={() => setHoveredWithDelay(null)}
      >
        <div className="max-h-[min(480px,calc(100vh-8rem))] overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg">
          {loadingProviders.has(p.id) ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={14} className="animate-spin text-muted-foreground" />
            </div>
          ) : (
            renderGroupedModels(getModels(p), p.id, isSelected)
          )}
        </div>
      </div>
    );
  };

  return (
    <div ref={containerRef} className="relative">
      <Button variant="ghost" size="xs" onClick={() => setOpen(!open)} className="text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors">
        <Icon size={14} className={iconClass} />
        <span className="text-sm">{shortLabel}</span>
        <ChevronDown size={11} />
      </Button>

      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-lg">
          {/* When provider is locked, show only that provider's models directly */}
          {providerLocked && displayProvider ? (
            <div className="max-h-[min(480px,calc(100vh-8rem))] overflow-y-auto">
              {loadingProviders.has(displayProvider.id) ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 size={14} className="animate-spin text-muted-foreground" />
                </div>
              ) : (
                renderGroupedModels(
                  getModels(displayProvider),
                  displayProvider.id,
                  (id) => id === normalizedSelectedId
                )
              )}
            </div>
          ) : MODEL_PROVIDERS.map((p) => {
            const pm = PROVIDER_META[p.id];
            const ProvIcon = pm?.icon ?? ClaudeIcon;
            const provIconClass = pm?.color ?? "";
            const hasModels = p.models.length > 0;

            // Derive disabled state from the availability store. An absent record is treated
            // as enabled so newly-registered providers don't appear broken before the server
            // has had a chance to push their availability.
            const providerRecord = availabilityList.find((x) => x.id === p.id);
            const providerDisabled = providerRecord ? !providerRecord.enabled : false;

            return (
              <div
                key={p.id}
                data-testid={`model-group-${p.id}`}
                data-disabled={providerDisabled ? "true" : "false"}
                className={cn("relative", providerDisabled && "opacity-50 pointer-events-none")}
                onMouseEnter={() => {
                    if (!p.comingSoon && !providerDisabled && hasModels) {
                      setHoveredWithDelay(p.id);
                      if (p.supportsModelListing) fetchProviderModels(p.id);
                    }
                  }}
                onMouseLeave={() => setHoveredWithDelay(null)}
              >
                <button
                  disabled={p.comingSoon || providerDisabled}
                  onClick={() => {
                    // Guard against disabled providers in case pointer-events-none is overridden
                    // by a theme or browser extension.
                    if (providerDisabled) return;
                    if (hasModels && p.models.length === 1) {
                      handleSelectModel(p.models[0].id, p.id);
                    }
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs",
                    p.comingSoon
                      ? "cursor-default text-muted-foreground/70"
                      : "text-popover-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                >
                  <ProvIcon size={12} className={p.comingSoon ? "opacity-40" : provIconClass} />
                  <span className="flex-1 text-left">{p.name}</span>
                  {p.comingSoon && (
                    <Badge variant="secondary" size="sm">SOON</Badge>
                  )}
                  {providerDisabled && (
                    <Badge variant="outline" size="sm">Disabled</Badge>
                  )}
                  {!p.comingSoon && !providerDisabled && hasModels && p.models.length > 1 && (
                    <ChevronRight size={10} className="text-muted-foreground" />
                  )}
                </button>
                {hoveredProvider === p.id && hasModels && p.models.length > 1 && renderSubmenu(p)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
