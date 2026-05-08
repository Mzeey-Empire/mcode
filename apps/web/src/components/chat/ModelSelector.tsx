import { useState, useEffect, useRef, useCallback, useMemo, type ComponentType } from "react";
import { ChevronDown, Lock, Check, Loader2, Star } from "lucide-react";
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

/** Left rail segment: browse starred models or a single provider's catalog. */
type LeftRailSelection = "favorites" | string;

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
  const [leftRailSelection, setLeftRailSelection] = useState<LeftRailSelection>("favorites");
  const [rightPanelSearch, setRightPanelSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const prevOpenRef = useRef(false);

  const favorites = useModelFavoritesStore((s) => s.entries);
  const toggleFavorite = useModelFavoritesStore((s) => s.toggleFavorite);
  const isFavorite = useModelFavoritesStore((s) => s.isFavorite);

  const availabilityList = useProviderAvailabilityStore((s) => s.providers);

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

  const model = findModelById(selectedModelId);
  const normalizedSelectedId = model?.id ?? selectedModelId;

  const displayProvider = selectedProviderId
    ? MODEL_PROVIDERS.find((p) => p.id === selectedProviderId)
    : MODEL_PROVIDERS.find((p) => p.models.some((m) => m.id === normalizedSelectedId));

  const meta = displayProvider ? PROVIDER_META[displayProvider.id] : undefined;
  const Icon = meta?.icon ?? ClaudeIcon;
  const iconClass = meta?.color ?? "";
  const shortLabel = model && displayProvider
    ? model.label.replace(`${displayProvider.name} `, "")
    : (model?.label ?? selectedModelId);

  const defaultProviderId = useMemo(() => {
    const preferred = selectedProviderId ?? displayProvider?.id;
    if (preferred && MODEL_PROVIDERS.some((p) => p.id === preferred)) return preferred;
    return MODEL_PROVIDERS.find((p) => !p.comingSoon)?.id ?? "favorites";
  }, [selectedProviderId, displayProvider?.id]);

  const providersForLeftRail = useMemo(() => {
    if (providerLocked && displayProvider) {
      return MODEL_PROVIDERS.filter((p) => p.id === displayProvider.id);
    }
    return MODEL_PROVIDERS;
  }, [providerLocked, displayProvider]);

  const favoritesVisible = useMemo(() => {
    return favorites.filter((f) => {
      if (!isProviderUsable(f.providerId)) return false;
      if (providerLocked && displayProvider && f.providerId !== displayProvider.id) return false;
      return true;
    });
  }, [favorites, isProviderUsable, providerLocked, displayProvider]);

  const favoritesFiltered = useMemo(() => {
    const n = rightPanelSearch.trim().toLowerCase();
    if (!n) return favoritesVisible;
    return favoritesVisible.filter(
      (f) =>
        f.label.toLowerCase().includes(n) ||
        f.modelId.toLowerCase().includes(n),
    );
  }, [favoritesVisible, rightPanelSearch]);

  /** When the menu opens, reset rail + search so the right pane matches the current thread provider. */
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      if (providerLocked && displayProvider) {
        setLeftRailSelection(displayProvider.id);
      } else {
        setLeftRailSelection(defaultProviderId);
      }
      setRightPanelSearch("");
    }
    prevOpenRef.current = open;
  }, [open, providerLocked, displayProvider?.id, defaultProviderId]);

  useEffect(() => {
    if (!open || locked) return;
    if (leftRailSelection !== "favorites") {
      void fetchProviderModels(leftRailSelection);
      return;
    }
    const ids = new Set<string>();
    for (const f of favoritesVisible) {
      ids.add(f.providerId);
    }
    for (const id of ids) void fetchProviderModels(id);
  }, [open, locked, leftRailSelection, favoritesVisible, fetchProviderModels]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
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
  };

  const selectLeftRail = (key: LeftRailSelection) => {
    setLeftRailSelection(key);
    setRightPanelSearch("");
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
    isSelected: (id: string) => boolean,
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
              : "text-popover-foreground hover:bg-accent/50 hover:text-foreground",
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

  const panelSearchTestId =
    providerLocked && displayProvider ? "model-selector-locked-search" : "model-selector-panel-search";

  const renderRightPanel = () => {
    if (leftRailSelection === "favorites") {
      if (favoritesFiltered.length === 0) {
        const emptyList = favoritesVisible.length === 0;
        return (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground leading-relaxed">
            {emptyList
              ? "No favorites yet. Open a provider on the left, then star models you use often."
              : "No favorites match your search."}
          </p>
        );
      }
      return (
        <div className="space-y-0.5">
          <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 select-none">
            Favorites
          </div>
          {favoritesFiltered.map((entry) => renderFavoriteRow(entry))}
        </div>
      );
    }

    const p = MODEL_PROVIDERS.find((x) => x.id === leftRailSelection);
    if (!p) return null;

    const isSelected = (modelId: string) =>
      modelId === normalizedSelectedId && p.id === (selectedProviderId ?? displayProvider?.id);

    return (
      <div className="space-y-0.5">
        <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 select-none">
          {p.name}
        </div>
        {loadingProviders.has(p.id) ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={14} className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          renderGroupedModels(getModels(p), p.id, isSelected, rightPanelSearch)
        )}
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
        <div
          className={cn(
            "absolute bottom-full left-0 z-20 mb-1 flex max-h-[min(480px,calc(100vh-8rem))] w-[min(92vw,520px)] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-lg",
          )}
        >
          <div className="flex shrink-0 border-b border-border/40">
            <div className="flex w-[148px] shrink-0 items-center border-r border-border/40 px-2 py-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 select-none">
                {providerLocked ? "Scope" : "Browse"}
              </span>
            </div>
            <div className="min-w-0 flex-1 p-1.5">
              <Input
                size="xs"
                placeholder={leftRailSelection === "favorites" ? "Search favorites…" : "Search models…"}
                value={rightPanelSearch}
                onChange={(e) => setRightPanelSearch(e.target.value)}
                data-testid={panelSearchTestId}
                className="h-7"
              />
            </div>
          </div>

          <div className="flex min-h-0 flex-1 divide-x divide-border/40">
            <div className="flex w-[148px] shrink-0 flex-col gap-0.5 overflow-y-auto bg-muted/15 p-1">
              <button
                type="button"
                data-testid="model-selector-rail-favorites"
                onClick={() => selectLeftRail("favorites")}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors",
                  leftRailSelection === "favorites"
                    ? "bg-accent text-foreground shadow-sm"
                    : "text-popover-foreground hover:bg-accent/40 hover:text-foreground",
                )}
              >
                <Star
                  size={14}
                  className={cn(
                    "shrink-0 text-muted-foreground",
                    leftRailSelection === "favorites" && "fill-amber-400 text-amber-400",
                  )}
                />
                <span className="truncate font-medium">Favorites</span>
              </button>

              <div className="my-0.5 border-t border-border/40" />

              {providersForLeftRail.map((p) => {
                const pm = PROVIDER_META[p.id];
                const ProvIcon = pm?.icon ?? ClaudeIcon;
                const provIconClass = pm?.color ?? "";
                const providerRecord = availabilityList.find((x) => x.id === p.id);
                const providerDisabled = providerRecord ? !providerRecord.enabled : false;
                const singleStaticModel = p.models.length === 1;

                return (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`model-group-${p.id}`}
                    data-disabled={providerDisabled ? "true" : "false"}
                    disabled={p.comingSoon || providerDisabled}
                    onClick={() => {
                      if (providerDisabled) return;
                      if (singleStaticModel) {
                        handleSelectModel(p.models[0].id, p.id);
                        return;
                      }
                      selectLeftRail(p.id);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors",
                      p.comingSoon || providerDisabled
                        ? "cursor-not-allowed opacity-50"
                        : "text-popover-foreground hover:bg-accent/40 hover:text-foreground",
                      leftRailSelection === p.id && !singleStaticModel && "bg-accent text-foreground shadow-sm",
                    )}
                  >
                    <ProvIcon size={14} className={p.comingSoon ? "opacity-40" : provIconClass} />
                    <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5">
                      {p.comingSoon && (
                        <Badge variant="secondary" size="sm">SOON</Badge>
                      )}
                      {providerDisabled && (
                        <Badge variant="outline" size="sm">Disabled</Badge>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="min-h-[220px] min-w-0 flex-1 overflow-y-auto bg-popover p-1">
              {renderRightPanel()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
