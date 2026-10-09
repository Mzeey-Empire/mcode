import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ChevronDown, Lock, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PICKER_PANEL_CLASS, Picker, type PickerRow, type PickerTab } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  MODEL_PROVIDERS,
  findModelById,
  isModelAvailable,
  registerProviderModels,
  type ModelProvider,
} from "@/lib/model-registry";
import { getTransport } from "@/transport";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import {
  useModelFavoritesStore,
  type ModelFavoriteEntry,
} from "@/stores/modelFavoritesStore";
import { tokenizeSearch, matchesAllTokens } from "@/lib/searchTokens";
import { ProviderIcon } from "@/components/ui/provider-icon";

/** Provider shown when the selected model belongs to no known provider. */
const DEFAULT_PROVIDER_ID = "claude";

function iconProviderIdFor(provider: ModelProvider | undefined): string {
  return provider?.id ?? DEFAULT_PROVIDER_ID;
}

/** How long to wait before retrying a provider after a failed fetch. */
const FETCH_RETRY_COOLDOWN_MS = 30_000;

/** True when the catalog uses subgroup rows so a provider title above would repeat RPC group labels. */
function catalogUsesModelGroups(models: ModelProvider["models"]): boolean {
  return models.some((model) => Boolean(model.group?.trim()));
}

/** Tooltip copy for a provider tab that cannot open a catalog. */
function providerTabUnavailableReason(
  provider: ModelProvider,
  providerDisabled: boolean,
): string {
  if (provider.comingSoon && providerDisabled) {
    return `${provider.name} is coming soon and disabled in settings.`;
  }
  if (provider.comingSoon) return `${provider.name} is coming soon.`;
  if (providerDisabled) {
    return `${provider.name} is disabled. Enable it in Settings under Providers.`;
  }
  return provider.name;
}

const FAVORITES_TAB = "favorites";

/** Picker tab: starred models or a single provider's catalog. */
type ModelPickerTab = typeof FAVORITES_TAB | string;

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

interface SelectedModelPresentation {
  displayProvider?: ModelProvider;
  normalizedModelId: string;
  selectedProviderId?: string;
  iconProviderId: string;
  shortLabel: string;
}

interface ProviderModelCatalog {
  getModels: (provider: ModelProvider) => ModelProvider["models"];
  loadingProviders: Set<string>;
  fetchProviderModels: (providerId: string) => Promise<void>;
}

/** One model the picker can list, from a provider catalog or the favourites. */
interface ModelOption {
  readonly modelId: string;
  readonly providerId: string;
  readonly label: string;
  /** Catalog subgroup, so the list can divide groups. */
  readonly group?: string;
  /** Formatted end date of a model whose subscription access has ended. */
  readonly endedOn?: string;
  /** Favourites mix providers, so their rows name the provider under the model. */
  readonly showProvider: boolean;
}

function findDisplayProvider(
  selectedProviderId: string | undefined,
  normalizedModelId: string,
): ModelProvider | undefined {
  if (selectedProviderId) {
    return MODEL_PROVIDERS.find((provider) => provider.id === selectedProviderId);
  }
  return MODEL_PROVIDERS.find((provider) =>
    provider.models.some((model) => model.id === normalizedModelId),
  );
}

function getSelectedModelPresentation(
  selectedModelId: string,
  selectedProviderId: string | undefined,
): SelectedModelPresentation {
  const model = findModelById(selectedModelId);
  const normalizedModelId = model?.id ?? selectedModelId;
  const displayProvider = findDisplayProvider(selectedProviderId, normalizedModelId);
  const label = model?.label ?? selectedModelId;
  const shortLabel = model && displayProvider
    ? label.replace(`${displayProvider.name} `, "")
    : label;

  return {
    displayProvider,
    normalizedModelId,
    selectedProviderId: selectedProviderId ?? displayProvider?.id,
    iconProviderId: iconProviderIdFor(displayProvider),
    shortLabel,
  };
}

function getDefaultProviderId(
  selectedProviderId: string | undefined,
  displayProvider: ModelProvider | undefined,
): ModelPickerTab {
  const preferredProviderId = selectedProviderId ?? displayProvider?.id;
  const providerExists = preferredProviderId
    ? MODEL_PROVIDERS.some((provider) => provider.id === preferredProviderId)
    : false;

  if (providerExists) return preferredProviderId!;
  return MODEL_PROVIDERS.find((provider) => !provider.comingSoon)?.id ?? FAVORITES_TAB;
}

function getProvidersForLeftRail(
  providerLocked: boolean | undefined,
  displayProvider: ModelProvider | undefined,
): readonly ModelProvider[] {
  if (providerLocked && displayProvider) {
    return MODEL_PROVIDERS.filter((provider) => provider.id === displayProvider.id);
  }
  return MODEL_PROVIDERS;
}

function isProviderUsable(
  providerId: string,
  availabilityList: readonly {
    id: string;
    enabled: boolean;
    hasAdapter: boolean;
    cli: { status: string };
  }[],
): boolean {
  const provider = availabilityList.find((entry) => entry.id === providerId);
  if (!provider) return true;
  return provider.enabled && provider.hasAdapter && provider.cli.status !== "not_found";
}

function getVisibleFavorites(
  favorites: readonly ModelFavoriteEntry[],
  canUseProvider: (providerId: string) => boolean,
  providerLocked: boolean | undefined,
  displayProvider: ModelProvider | undefined,
): ModelFavoriteEntry[] {
  return favorites.filter((favorite) => {
    const providerIsHidden = !canUseProvider(favorite.providerId);
    const outsideLockedProvider = providerLocked
      && displayProvider
      && favorite.providerId !== displayProvider.id;
    return !providerIsHidden && !outsideLockedProvider;
  });
}

function filterModelsBySearchQuery(
  models: ModelProvider["models"],
  searchQuery: string,
): ModelProvider["models"] {
  const tokens = tokenizeSearch(searchQuery);
  if (tokens.length === 0) return models;
  return models.filter((model) =>
    matchesAllTokens([model.label, model.id, model.group ?? ""], tokens),
  );
}

function filterFavoritesBySearchQuery(
  favorites: readonly ModelFavoriteEntry[],
  searchQuery: string,
): ModelFavoriteEntry[] {
  const tokens = tokenizeSearch(searchQuery);
  if (tokens.length === 0) return [...favorites];
  return favorites.filter((favorite) =>
    matchesAllTokens([favorite.label, favorite.modelId], tokens),
  );
}

function groupModels(models: ModelProvider["models"]): { label: string; models: ModelProvider["models"] }[] | null {
  if (!catalogUsesModelGroups(models)) return null;

  const groups = new Map<string, ModelProvider["models"]>();
  for (const model of models) {
    const label = model.group?.trim() ?? "";
    const groupedModels = groups.get(label) ?? [];
    groups.set(label, [...groupedModels, model]);
  }
  return [...groups].map(([label, groupedModels]) => ({
    label,
    models: groupedModels,
  }));
}

function getFavoriteActionLabel(label: string, starred: boolean): string {
  return starred ? `Remove ${label} from favourites` : `Add ${label} to favourites`;
}

function getProviderDisabled(
  providerId: string,
  availabilityList: readonly { id: string; enabled: boolean }[],
): boolean {
  const provider = availabilityList.find((entry) => entry.id === providerId);
  return provider ? !provider.enabled : false;
}

function isProviderTabUnavailable(
  provider: ModelProvider,
  providerDisabled: boolean,
): boolean {
  return provider.comingSoon || providerDisabled;
}

function useProviderModelCatalog(): ProviderModelCatalog {
  const [dynamicModels, setDynamicModels] = useState<Map<string, ModelProvider["models"]>>(
    new Map(),
  );
  const dynamicModelsRef = useRef<Map<string, ModelProvider["models"]>>(new Map());
  const [loadingProviders, setLoadingProviders] = useState<Set<string>>(new Set());
  const fetchingRef = useRef<Set<string>>(new Set());
  const fetchFailedAtRef = useRef<Map<string, number>>(new Map());

  const fetchProviderModels = useCallback(async (providerId: string) => {
    const lastFailedAt = fetchFailedAtRef.current.get(providerId);
    const isCoolingDown = lastFailedAt !== undefined
      && Date.now() - lastFailedAt < FETCH_RETRY_COOLDOWN_MS;

    if (
      fetchingRef.current.has(providerId)
      || dynamicModelsRef.current.has(providerId)
      || isCoolingDown
    ) {
      return;
    }

    fetchingRef.current.add(providerId);
    setLoadingProviders((currentProviders) => new Set(currentProviders).add(providerId));
    try {
      const providerModels = await getTransport().listProviderModels(providerId);
      const models: ModelProvider["models"] = providerModels.map((model) => ({
        id: model.id,
        label: model.name,
        providerId,
        group: model.group,
        contextWindow: model.contextWindow,
        supportedReasoningLevels: model.supportedReasoningEfforts,
        defaultReasoningLevel: model.defaultReasoningEffort,
        multiplier: model.multiplier,
      }));
      const updatedModels = new Map(dynamicModelsRef.current).set(providerId, models);
      dynamicModelsRef.current = updatedModels;
      setDynamicModels(updatedModels);
      registerProviderModels(providerId, models);
    } catch {
      fetchFailedAtRef.current.set(providerId, Date.now());
    } finally {
      fetchingRef.current.delete(providerId);
      setLoadingProviders((currentProviders) => {
        const nextProviders = new Set(currentProviders);
        nextProviders.delete(providerId);
        return nextProviders;
      });
    }
  }, []);

  const getModels = useCallback((provider: ModelProvider): ModelProvider["models"] => {
    const models = dynamicModels.get(provider.id);
    return models && models.length > 0 ? models : provider.models;
  }, [dynamicModels]);

  return { getModels, loadingProviders, fetchProviderModels };
}

function useResetPickerOnOpen(
  open: boolean,
  providerLocked: boolean | undefined,
  displayProvider: ModelProvider | undefined,
  defaultProviderId: ModelPickerTab,
  setActiveTab: (tab: ModelPickerTab) => void,
  setQuery: (searchQuery: string) => void,
): void {
  const previouslyOpen = useRef(false);
  const displayProviderId = displayProvider?.id;

  useEffect(() => {
    const opened = open && !previouslyOpen.current;
    if (opened) {
      const nextTab = providerLocked && displayProviderId
        ? displayProviderId
        : defaultProviderId;
      setActiveTab(nextTab);
      setQuery("");
    }
    previouslyOpen.current = open;
  }, [open, providerLocked, displayProviderId, defaultProviderId, setActiveTab, setQuery]);
}

function useFetchProviderModelsWhenOpen(
  open: boolean,
  locked: boolean,
  activeTab: ModelPickerTab,
  favoritesVisible: readonly ModelFavoriteEntry[],
  fetchProviderModels: (providerId: string) => Promise<void>,
): void {
  useEffect(() => {
    if (!open || locked) return;

    if (activeTab !== FAVORITES_TAB) {
      void fetchProviderModels(activeTab);
      return;
    }

    const providerIds = new Set(favoritesVisible.map((favorite) => favorite.providerId));
    for (const providerId of providerIds) {
      void fetchProviderModels(providerId);
    }
  }, [open, locked, activeTab, favoritesVisible, fetchProviderModels]);
}

function optionKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

function providerName(providerId: string): string {
  return MODEL_PROVIDERS.find((provider) => provider.id === providerId)?.name ?? providerId;
}

function formatEndDate(availableUntil: string): string {
  return new Date(`${availableUntil}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function providerModelOptions(
  providerId: string,
  models: ModelProvider["models"],
  searchQuery: string,
): ModelOption[] {
  const filteredModels = filterModelsBySearchQuery(models, searchQuery);
  const groups = groupModels(filteredModels) ?? [{ label: undefined, models: filteredModels }];
  return groups.flatMap((group) =>
    group.models.map((model) => ({
      modelId: model.id,
      providerId,
      label: model.label,
      group: group.label,
      endedOn: model.availableUntil && !isModelAvailable(model) ? formatEndDate(model.availableUntil) : undefined,
      showProvider: false,
    })),
  );
}

function favoriteModelOptions(favorites: readonly ModelFavoriteEntry[]): ModelOption[] {
  return favorites.map((favorite) => ({
    modelId: favorite.modelId,
    providerId: favorite.providerId,
    label: favorite.label,
    showProvider: true,
  }));
}

function getPickerTabs(
  providers: readonly ModelProvider[],
  lockedToProvider: boolean,
  isProviderDisabled: (providerId: string) => boolean,
): PickerTab[] {
  const providerTabs = providers.map((provider): PickerTab => {
    const providerDisabled = isProviderDisabled(provider.id);
    const unavailable = isProviderTabUnavailable(provider, providerDisabled);
    return {
      id: provider.id,
      label: provider.name,
      icon: <ProviderIcon provider={provider.id} className="size-[1.4rem]" />,
      disabled: unavailable,
      disabledReason: unavailable ? providerTabUnavailableReason(provider, providerDisabled) : undefined,
    };
  });
  if (lockedToProvider) return providerTabs;
  return [
    { id: FAVORITES_TAB, label: "Favourites", icon: <Star aria-hidden className="size-[1.4rem]" strokeWidth={1.5} /> },
    ...providerTabs,
  ];
}

function FavoriteStar({
  option,
  starred,
  onToggle,
}: {
  option: ModelOption;
  starred: boolean;
  onToggle: (entry: ModelFavoriteEntry) => void;
}) {
  return (
    <button
      type="button"
      aria-label={getFavoriteActionLabel(option.label, starred)}
      aria-pressed={starred}
      onClick={() => onToggle({ providerId: option.providerId, modelId: option.modelId, label: option.label })}
      className={cn(
        "flex size-[1.4rem] items-center justify-center rounded-xs outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // An unstarred star shows only on the highlighted row, so the list reads as a column of names.
        !starred && "opacity-0 focus-visible:opacity-100 group-data-active/option:opacity-100",
      )}
    >
      <Star
        aria-hidden
        className={cn("size-[1.4rem]", starred ? "fill-primary text-primary" : "text-ink")}
        strokeWidth={1.5}
      />
    </button>
  );
}

function LockedModelLabel({
  iconProviderId,
  shortLabel,
}: Pick<SelectedModelPresentation, "iconProviderId" | "shortLabel">) {
  return (
    <span
      className="flex flex-none max-w-full items-center gap-0.5 px-1.5 py-1 text-xs text-muted"
      aria-label={shortLabel}
      role="img"
    >
      <ProviderIcon provider={iconProviderId} size={12} />
      <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{shortLabel}</span>
      <Lock size={10} className="ml-0.5 shrink-0 opacity-75" aria-hidden />
    </span>
  );
}

/**
 * Composer model picker: a {@link Picker} with a Favourites tab and one tab per provider. A locked
 * thread shows the model as a label; a provider-locked thread keeps only its provider's tab.
 */
export function ModelSelector({
  selectedModelId,
  selectedProviderId,
  onSelect,
  locked,
  providerLocked,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ModelPickerTab>(FAVORITES_TAB);
  const [query, setQuery] = useState("");

  const favorites = useModelFavoritesStore((store) => store.entries);
  const toggleFavorite = useModelFavoritesStore((store) => store.toggleFavorite);
  const availabilityList = useProviderAvailabilityStore((store) => store.providers);
  const { getModels, loadingProviders, fetchProviderModels } = useProviderModelCatalog();
  const presentation = getSelectedModelPresentation(selectedModelId, selectedProviderId);
  const { displayProvider } = presentation;

  const canUseProvider = useCallback(
    (providerId: string) => isProviderUsable(providerId, availabilityList),
    [availabilityList],
  );
  const isProviderDisabled = useCallback(
    (providerId: string) => getProviderDisabled(providerId, availabilityList),
    [availabilityList],
  );
  const defaultProviderId = getDefaultProviderId(selectedProviderId, displayProvider);
  const tabs = getPickerTabs(
    getProvidersForLeftRail(providerLocked, displayProvider),
    Boolean(providerLocked && displayProvider),
    isProviderDisabled,
  );
  const favoritesVisible = useMemo(
    () => getVisibleFavorites(favorites, canUseProvider, providerLocked, displayProvider),
    [favorites, canUseProvider, providerLocked, displayProvider],
  );
  const starredKeys = useMemo(
    () => new Set(favorites.map((favorite) => optionKey(favorite.providerId, favorite.modelId))),
    [favorites],
  );

  const items = useMemo(() => {
    if (activeTab === FAVORITES_TAB) {
      return favoriteModelOptions(filterFavoritesBySearchQuery(favoritesVisible, query));
    }
    const provider = MODEL_PROVIDERS.find((entry) => entry.id === activeTab);
    return provider ? providerModelOptions(provider.id, getModels(provider), query) : [];
  }, [activeTab, favoritesVisible, getModels, query]);

  const renderItem = useCallback(
    (option: ModelOption): PickerRow => {
      const key = optionKey(option.providerId, option.modelId);
      return {
        key,
        name: option.label,
        group: option.group,
        disabled: option.endedOn !== undefined,
        disabledReason: option.endedOn && `Subscription access to ${option.label} ended on ${option.endedOn}.`,
        description: option.showProvider ? (
          <>
            <ProviderIcon provider={option.providerId} size={12} />
            <span className="min-w-0 text-fade">{providerName(option.providerId)}</span>
          </>
        ) : undefined,
        action: option.endedOn ? undefined : (
          <FavoriteStar option={option} starred={starredKeys.has(key)} onToggle={toggleFavorite} />
        ),
      };
    },
    [starredKeys, toggleFavorite],
  );

  useResetPickerOnOpen(open, providerLocked, displayProvider, defaultProviderId, setActiveTab, setQuery);
  useFetchProviderModelsWhenOpen(open, locked, activeTab, favoritesVisible, fetchProviderModels);

  const handleSelectModel = (modelId: string, providerId: string) => {
    onSelect(modelId, providerId);
    setOpen(false);
  };
  const handleTabChange = (tabId: string) => {
    const provider = MODEL_PROVIDERS.find((entry) => entry.id === tabId);
    // A one-model provider has nothing to browse, so choosing its tab chooses its model.
    if (provider?.models.length === 1) {
      handleSelectModel(provider.models[0].id, provider.id);
      return;
    }
    setActiveTab(tabId);
  };

  if (locked) {
    return <LockedModelLabel {...presentation} />;
  }

  const loading = activeTab !== FAVORITES_TAB && loadingProviders.has(activeTab);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="compact"
            data-testid="model-selector-trigger"
            className="max-w-full shrink whitespace-normal text-muted transition-colors hover:bg-hover/40 hover:text-ink"
          >
            <ProviderIcon provider={presentation.iconProviderId} size={16} />
            <span className="min-w-0 whitespace-normal text-sm [overflow-wrap:anywhere]">{presentation.shortLabel}</span>
            <ChevronDown size={11} className="shrink-0" aria-hidden />
          </Button>
        }
      />
      <PopoverContent
        role="dialog"
        aria-label="Choose model and provider"
        side="top"
        align="start"
        className={PICKER_PANEL_CLASS}
      >
        <Picker
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder="Search models"
          items={items}
          total={null}
          status={loading ? "loading" : "ready"}
          selectedKey={
            presentation.selectedProviderId
              ? optionKey(presentation.selectedProviderId, presentation.normalizedModelId)
              : undefined
          }
          renderItem={renderItem}
          onSelect={(option) => handleSelectModel(option.modelId, option.providerId)}
        />
      </PopoverContent>
    </Popover>
  );
}
