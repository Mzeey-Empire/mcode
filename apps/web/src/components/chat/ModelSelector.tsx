import { useState, useEffect, useRef, useCallback, useMemo, type ComponentType } from "react";
import { ChevronDown, ChevronRight, Lock, Check, Loader2, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatContextWindow } from "./format-context-window";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  MODEL_PROVIDERS,
  findModelById,
  type ModelProvider,
} from "@/lib/model-registry";
import { getTransport } from "@/transport";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import {
  useModelFavoritesStore,
  type ModelFavoriteEntry,
} from "@/stores/modelFavoritesStore";
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
  cursor: { icon: CursorProviderIcon, color: "" },
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
  const [favoriteSearch, setFavoriteSearch] = useState("");
  const [submenuSearch, setSubmenuSearch] = useState("");
  const [lockedPanelSearch, setLockedPanelSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const favorites = useModelFavoritesStore((s) => s.entries);
  const toggleFavorite = useModelFavoritesStore((s) => s.toggleFavorite);
  const isFavorite = useModelFavoritesStore((s) => s.isFavorite);

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

  /**
   * Returns live models for a provider, falling back to the static registry.
   * Empty dynamic lists fall through to the static registry — `listClaudeModels`
   * returns `[]` when ANTHROPIC_API_KEY is unset, and `??` does not fall
   * through on a truthy empty array, which would hide all Claude models.
   */
  const getModels = (p: ModelProvider): ModelProvider["models"] => {
    const dynamic = dynamicModels.get(p.id);
    return dynamic && dynamic.length > 0 ? dynamic : p.models;
  };

  const isProviderUsable = useCallback(
    (id: string) => {
      const r = availabilityList.find((x) => x.id === id);
      if (!r) return true;
      return r.enabled && r.hasAdapter && r.cli.status !== "not_found";
    },
    [availabilityList],
  );

  const filterModelsBySearch = useCallback((models: ModelProvider["models"], q: string) => {
    const n = q.trim().toLowerCase();
    if (!n) return models;
    return models.filter(
      (m) =>
        m.label.toLowerCase().includes(n) ||
        m.id.toLowerCase().includes(n),
    );
  }, []);

  useEffect(() => {
    if (!open) {
      setFavoriteSearch("");
      setSubmenuSearch("");
      setLockedPanelSearch("");
    }
  }, [open]);

  useEffect(() => {
    setSubmenuSearch("");
  }, [hoveredProvider]);

  useEffect(() => {
    if (!open || locked) return;
    const ids = new Set<string>();
    for (const f of favorites) {
      if (isProviderUsable(f.providerId)) ids.add(f.providerId);
    }
    for (const id of ids) void fetchProviderModels(id);
  }, [open, locked, favorites, fetchProviderModels, isProviderUsable]);

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

  const favoriteSearchNorm = favoriteSearch.trim().toLowerCase();

  const filteredFavorites = useMemo(() => {
    return favorites.filter((f) => {
      if (!isProviderUsable(f.providerId)) return false;
      if (providerLocked && displayProvider && f.providerId !== displayProvider.id) return false;
      if (!favoriteSearchNorm) return true;
      return (
        f.label.toLowerCase().includes(favoriteSearchNorm) ||
        f.modelId.toLowerCase().includes(favoriteSearchNorm)
      );
    });
  }, [favorites, favoriteSearchNorm, isProviderUsable, providerLocked, displayProvider]);

  // For a provider-locked thread, fetch immediately so the list is current.
  useEffect(() => {
    if (providerLocked && displayProvider) {
      fetchProviderModels(displayProvider.id);
    }
  }, [providerLocked, displayProvider?.id, fetchProviderModels]);

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

  const renderFavoriteRow = (entry: ModelFavoriteEntry) => {
    const pm = PROVIDER_META[entry.providerId];
    const ProvIcon = pm?.icon ?? ClaudeIcon;
    const provIconClass = pm?.color ?? "";
    const starred = isFavorite(entry.providerId, entry.modelId);
    return (
      <div
        key={`${entry.providerId}:${entry.modelId}`}
        className="flex w-full items-center gap-0.5 rounded px-1"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={starred ? "Remove from favorites" : "Add to favorites"}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite({
              providerId: entry.providerId,
              modelId: entry.modelId,
              label: entry.label,
            });
          }}
        >
          <Star
            size={12}
            className={cn(starred && "fill-amber-400 text-amber-400")}
          />
        </Button>
        <button
          type="button"
          onClick={() => handleSelectModel(entry.modelId, entry.providerId)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-xs",
            entry.modelId === normalizedSelectedId && entry.providerId === (selectedProviderId ?? displayProvider?.id)
              ? "bg-accent text-foreground"
              : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <ProvIcon size={12} className={provIconClass} />
          <span className="truncate text-left">{entry.label}</span>
        </button>
      </div>
    );
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
    const starred = isFavorite(providerId, m.id);
    return (
      <div key={m.id} className="flex w-full items-center gap-0.5 rounded px-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={starred ? "Remove from favorites" : "Add to favorites"}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite({ providerId, modelId: m.id, label: m.label });
          }}
        >
          <Star
            size={12}
            className={cn(starred && "fill-amber-400 text-amber-400")}
          />
        </Button>
        <button
          type="button"
          onClick={() => handleSelectModel(m.id, providerId)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-xs",
            isSelected(m.id)
              ? "bg-accent text-foreground"
              : "text-popover-foreground hover:bg-accent/50 hover:text-foreground"
          )}
        >
          <span className="flex-1 truncate text-left">{m.label}</span>
          {ctxLabel && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
              {ctxLabel}
            </span>
          )}
          {m.multiplier != null && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
              {m.multiplier}x
            </span>
          )}
          {isSelected(m.id) && (
            <Check size={10} className="shrink-0 text-foreground" />
          )}
        </button>
      </div>
    );
  };

  const renderGroupedModels = (
    models: ModelProvider["models"],
    providerId: string,
    isSelected: (id: string) => boolean,
    searchQuery: string,
  ) => {
    const filtered = filterModelsBySearch(models, searchQuery);
    const groups = groupModels(filtered);
    if (!groups) {
      return filtered.map((m) => renderModelRow(m, providerId, isSelected));
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
        className="absolute left-full bottom-0 z-30 -ml-1 min-w-[220px] pl-2"
        onMouseEnter={() => setHoveredWithDelay(p.id)}
        onMouseLeave={() => setHoveredWithDelay(null)}
      >
        <div className="flex max-h-[min(480px,calc(100vh-8rem))] flex-col overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          <div className="border-b border-border/40 p-1.5">
            <Input
              size="xs"
              placeholder="Search models..."
              value={submenuSearch}
              onChange={(e) => setSubmenuSearch(e.target.value)}
              data-testid="model-selector-submenu-search"
              className="h-7"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <div className="overflow-y-auto p-1">
            {loadingProviders.has(p.id) ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 size={14} className="animate-spin text-muted-foreground" />
              </div>
            ) : (
              renderGroupedModels(getModels(p), p.id, isSelected, submenuSearch)
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div ref={containerRef} className="relative">
      <Button variant="ghost" size="xs" data-testid="model-selector-trigger" onClick={() => setOpen(!open)} className="text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors">
        <Icon size={14} className={iconClass} />
        <span className="text-sm">{shortLabel}</span>
        <ChevronDown size={11} />
      </Button>

      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[240px] rounded-md border border-border bg-popover p-1 shadow-lg">
          {/* When provider is locked, show only that provider's models directly */}
          {providerLocked && displayProvider ? (
            <div className="flex max-h-[min(480px,calc(100vh-8rem))] flex-col overflow-hidden">
              <div className="border-b border-border/40 p-1.5">
                <Input
                  size="xs"
                  placeholder="Search favorites..."
                  value={favoriteSearch}
                  onChange={(e) => setFavoriteSearch(e.target.value)}
                  data-testid="model-selector-favorite-search"
                  className="h-7"
                />
              </div>
              {filteredFavorites.length > 0 && (
                <div className="border-b border-border/40 py-1">
                  <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 select-none">
                    Favorites
                  </div>
                  {filteredFavorites.map((entry) => renderFavoriteRow(entry))}
                </div>
              )}
              <div className="border-b border-border/40 p-1.5">
                <Input
                  size="xs"
                  placeholder="Search models..."
                  value={lockedPanelSearch}
                  onChange={(e) => setLockedPanelSearch(e.target.value)}
                  data-testid="model-selector-locked-search"
                  className="h-7"
                />
              </div>
              <div className="overflow-y-auto p-1">
                {loadingProviders.has(displayProvider.id) ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 size={14} className="animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  renderGroupedModels(
                    getModels(displayProvider),
                    displayProvider.id,
                    (id) => id === normalizedSelectedId,
                    lockedPanelSearch,
                  )
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="border-b border-border/40 p-1.5">
                <Input
                  size="xs"
                  placeholder="Search favorites..."
                  value={favoriteSearch}
                  onChange={(e) => setFavoriteSearch(e.target.value)}
                  data-testid="model-selector-favorite-search"
                  className="h-7"
                />
              </div>
              {filteredFavorites.length > 0 && (
                <div className="border-b border-border/40 py-1">
                  <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 select-none">
                    Favorites
                  </div>
                  {filteredFavorites.map((entry) => renderFavoriteRow(entry))}
                </div>
              )}
              {MODEL_PROVIDERS.map((p) => {
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
                      fetchProviderModels(p.id);
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
