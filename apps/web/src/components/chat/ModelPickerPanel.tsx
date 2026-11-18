import { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { Star } from "lucide-react";
import type { ReasoningLevel } from "@mcode/contracts/models/settings";
import { Picker, type PickerDetail, type PickerRow, type PickerRowAction, type PickerTab } from "@/components/ui/picker";
import { ReasoningLevelOptions } from "@/features/conversation/composer/controls/ComposerModelPreferences";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import {
  MODEL_PROVIDERS,
  findModelById,
  findProviderModel,
  getReasoningLevels,
  isModelAvailable,
  type ModelProvider,
} from "@/lib/model-registry";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useProviderModelsStore } from "@/stores/providerModelsStore";
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

/** How the selected model is named and drawn on a trigger. */
export interface SelectedModelPresentation {
  displayProvider?: ModelProvider;
  normalizedModelId: string;
  selectedProviderId?: string;
  iconProviderId: string;
  shortLabel: string;
}

/** One model the picker can list, from a provider catalog or the favourites. */
interface ModelOption {
  readonly kind: "model";
  readonly modelId: string;
  readonly providerId: string;
  readonly label: string;
  /** Catalog subgroup, so the list can divide groups. */
  readonly group?: string;
  /** Names the group above its first row; a search lists other providers' matches under their names. */
  readonly groupLabel?: string;
  /** Formatted end date of a model whose subscription access has ended. */
  readonly endedOn?: string;
  /** Favourites mix providers, so their rows name the provider under the model. */
  readonly showProvider: boolean;
}

/** The last row of a provider tab: Show more reveals its legacy models above it, and Show less hides them again. */
interface LegacyFoldOption {
  readonly kind: "legacy-fold";
  readonly providerId: string;
  readonly expanded: boolean;
  /** The group of the current models above, so no group gap opens between them and the fold. */
  readonly group: string | undefined;
}

/** The host's own first row, such as Auto, listed above every catalog. */
interface LeadOption {
  readonly kind: "lead";
  readonly label: string;
}

type ModelPickerOption = ModelOption | LegacyFoldOption | LeadOption;

const LEAD_KEY = "lead";

/**
 * The fold follows the selected model until the user toggles it: `auto` opens it only when the
 * selected model is legacy, so a thread's own model is never hidden behind it.
 */
type LegacyFoldState = "auto" | "open" | "closed";

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

/** Resolves the selected model's provider, icon and short name for a trigger. */
export function getSelectedModelPresentation(
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

/** Reads the shared, TTL-cached catalog, so remounting the panel neither refetches nor replaces its rows. */
function useProviderModelCatalog() {
  const models = useProviderModelsStore((store) => store.models);
  const loading = useProviderModelsStore((store) => store.loading);
  const fetchModels = useProviderModelsStore((store) => store.fetchModels);
  const getModels = useCallback((provider: ModelProvider): ModelProvider["models"] => {
    const fetched = models[provider.id];
    return fetched && fetched.length > 0 ? fetched : provider.models;
  }, [models]);
  return { getModels, loading, fetchModels };
}

function useFetchProviderModels(
  activeTab: ModelPickerTab,
  favoritesVisible: readonly ModelFavoriteEntry[],
  searchedProviders: readonly ModelProvider[],
  fetchModels: (providerId: string) => Promise<void>,
): void {
  useEffect(() => {
    if (activeTab !== FAVORITES_TAB) {
      void fetchModels(activeTab);
      for (const provider of searchedProviders) void fetchModels(provider.id);
      return;
    }

    const providerIds = new Set(favoritesVisible.map((favorite) => favorite.providerId));
    for (const providerId of providerIds) {
      void fetchModels(providerId);
    }
  }, [activeTab, favoritesVisible, searchedProviders, fetchModels]);
}

/** The provider tab: the host's when it passes `onTabChange`, otherwise the panel's own. */
function usePickerTab(
  defaultTab: ModelPickerTab,
  tab: string | null | undefined,
  onTabChange: ((tab: string) => void) | undefined,
): [ModelPickerTab, (tab: ModelPickerTab) => void] {
  const [ownTab, setOwnTab] = useState<ModelPickerTab>(defaultTab);
  if (!onTabChange) return [ownTab, setOwnTab];
  return [tab ?? defaultTab, onTabChange];
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

function isLegacyModel(model: ModelProvider["models"][number]): boolean {
  return model.lifecycle === "legacy";
}

/** Whether the legacy fold shows its models, given the user's toggle and the selected model. */
function isLegacyFoldExpanded(
  foldState: LegacyFoldState,
  models: ModelProvider["models"],
  selectedModelId: string | undefined,
): boolean {
  if (foldState !== "auto") return foldState === "open";
  return models.some((model) => isLegacyModel(model) && model.id === selectedModelId);
}

function catalogModelOptions(
  providerId: string,
  models: ModelProvider["models"],
  groupOverride?: string,
): ModelOption[] {
  const groups = groupModels(models) ?? [{ label: undefined, models }];
  return groups.flatMap((group) =>
    group.models.map((model) => ({
      kind: "model" as const,
      modelId: model.id,
      providerId,
      label: model.label,
      group: groupOverride ?? group.label,
      endedOn: accessEndedOn(model),
      showProvider: false,
    })),
  );
}

function underProviderName(options: readonly ModelPickerOption[], provider: ModelProvider): ModelPickerOption[] {
  return options.map((option) => ({ ...option, group: `provider:${provider.id}`, groupLabel: provider.name }));
}

/**
 * A search on a provider tab also lists every other usable provider's matches, so a model from another provider is one
 * search away instead of behind its tab. Once results span providers, every group, the tab's own included, carries
 * its provider's name, and a tab with no matches of its own is named as `unmatched` so the picker still says so.
 */
function searchAcrossProviders(
  active: ModelProvider,
  own: readonly ModelPickerOption[],
  providers: readonly ModelProvider[],
  getModels: (provider: ModelProvider) => ModelProvider["models"],
  searchQuery: string,
): ModelSearchResults {
  const others = providers
    .filter((provider) => provider.id !== active.id)
    .flatMap((provider) => underProviderName(catalogModelOptions(provider.id, filterModelsBySearchQuery(getModels(provider), searchQuery)), provider));
  if (others.length === 0) return { options: own };
  return { options: [...underProviderName(own, active), ...others], unmatched: own.length === 0 ? active.name : undefined };
}

interface ModelSearchResults {
  readonly options: readonly ModelPickerOption[];
  /** The tab's provider when the search found nothing in it but found other providers' models. */
  readonly unmatched?: string;
}

function providerModelOptions(
  providerId: string,
  models: ModelProvider["models"],
  searchQuery: string,
  legacyExpanded: boolean,
): ModelPickerOption[] {
  // A search reaches every model, so a legacy match is listed with the rest instead of behind the fold.
  if (tokenizeSearch(searchQuery).length > 0) {
    return catalogModelOptions(providerId, filterModelsBySearchQuery(models, searchQuery));
  }
  const currentOptions = catalogModelOptions(providerId, models.filter((model) => !isLegacyModel(model)));
  const legacyModels = models.filter(isLegacyModel);
  if (legacyModels.length === 0) return currentOptions;
  // The fold row already marks where the legacy models start, so they join the last current group instead of opening a
  // group of their own, which would draw an empty gap above them.
  const group = currentOptions.at(-1)?.group;
  const fold: LegacyFoldOption = { kind: "legacy-fold", providerId, expanded: legacyExpanded, group };
  if (!legacyExpanded) return [...currentOptions, fold];
  // Show less closes the list, so it sits after the legacy models rather than above them.
  return [...currentOptions, ...catalogModelOptions(providerId, legacyModels, group), fold];
}

function accessEndedOn(model: ModelProvider["models"][number]): string | undefined {
  return model.availableUntil && !isModelAvailable(model) ? formatEndDate(model.availableUntil) : undefined;
}

function favoriteModelOptions(
  favorites: readonly ModelFavoriteEntry[],
  getModels: (provider: ModelProvider) => ModelProvider["models"],
): ModelOption[] {
  return favorites.map((favorite) => {
    // A star outlives the model's access, so each favourite is checked against its provider's catalog.
    const provider = MODEL_PROVIDERS.find((entry) => entry.id === favorite.providerId);
    const model = provider && getModels(provider).find((entry) => entry.id === favorite.modelId);
    return {
      kind: "model" as const,
      modelId: favorite.modelId,
      providerId: favorite.providerId,
      label: favorite.label,
      endedOn: model ? accessEndedOn(model) : undefined,
      showProvider: true,
    };
  });
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
      icon: <ProviderIcon provider={provider.id} className="size-[1.8rem]" />,
      disabled: unavailable,
      disabledReason: unavailable ? providerTabUnavailableReason(provider, providerDisabled) : undefined,
    };
  });
  if (lockedToProvider) return providerTabs;
  return [
    // Lucide's star sits high in its box, so it drops 1px to centre with the provider marks beside it.
    { id: FAVORITES_TAB, label: "Favourites", icon: <Star aria-hidden className="size-[1.8rem] translate-y-px" /> },
    ...providerTabs,
  ];
}

function favoriteAction(
  option: ModelOption,
  starred: boolean,
  onToggle: (entry: ModelFavoriteEntry) => void,
): PickerRowAction {
  return {
    label: getFavoriteActionLabel(option.label, starred),
    icon: <Star className={starred ? "fill-primary text-primary" : "text-ink"} />,
    pinned: starred,
    run: () => onToggle({ providerId: option.providerId, modelId: option.modelId, label: option.label }),
  };
}

function legacyFoldRow(option: LegacyFoldOption): PickerRow {
  return {
    // The row moves to the end when it opens. A key per state hands the highlight to the row that takes its slot (the
    // first legacy model on open, Show more on close), so Enter never leaves the keyboard on a row scrolled out of view.
    key: `${option.providerId}:legacy-fold:${option.expanded ? "open" : "closed"}`,
    name: option.expanded ? "Show less" : "Show more",
    expanded: option.expanded,
    group: option.group,
  };
}


/** Props for {@link ModelPickerPanel}. */
export interface ModelPickerPanelProps {
  readonly selectedModelId: string;
  /**
   * Explicit provider ID for the selected model. Required when multiple providers share the same model ID (e.g.
   * "gpt-5.3-codex" exists in both Codex and Copilot); without it the wrong provider may be committed.
   */
  readonly selectedProviderId?: string;
  /** Started thread: only its provider's tab. */
  readonly providerLocked?: boolean;
  /** Controlled; the panel never resets it, so the host decides when the search starts over. */
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /**
   * Controlled provider tab when `onTabChange` is given; `null` starts on the selected model's provider. Without
   * `onTabChange` the panel owns the tab, so it starts over on every mount.
   */
  readonly tab?: string | null;
  readonly onTabChange?: (tab: string) => void;
  /** Called with the model and the provider it was picked from. A pick closes nothing here; the host decides. */
  readonly onSelect: (modelId: string, providerId: string) => void;
  /** Settings for the selected model, shown under the catalog. */
  readonly footer?: ReactNode;
  /** Shows the highlighted model's reasoning levels in a pane beside the list, so one click picks the model and its level. */
  readonly reasoning?: ModelPickerReasoning;
  /** A choice that is not a model, such as Auto, listed first on every tab. Omit for the catalog alone. Keep it stable across renders. */
  readonly lead?: ModelPickerLead;
}

/** The leading row of {@link ModelPickerPanel}. */
export interface ModelPickerLead {
  readonly label: string;
  /** True when the lead is the current choice, so it takes the selected mark instead of a model. */
  readonly selected: boolean;
  readonly onSelect: () => void;
}

/** Lists the lead first while no search runs or the search matches its label. */
function withLead(results: ModelSearchResults, lead: ModelPickerLead | undefined, searchQuery: string): ModelSearchResults {
  if (!lead || !matchesAllTokens([lead.label], tokenizeSearch(searchQuery))) return results;
  return { ...results, options: [{ kind: "lead", label: lead.label }, ...results.options] };
}

/** The lead's key while it is the current choice, else the selected model's. */
function selectedRowKey(lead: ModelPickerLead | undefined, presentation: SelectedModelPresentation): string | undefined {
  if (lead?.selected) return LEAD_KEY;
  return presentation.selectedProviderId ? optionKey(presentation.selectedProviderId, presentation.normalizedModelId) : undefined;
}

/** The current reasoning level and what choosing a level in the pane does. */
export interface ModelPickerReasoning {
  readonly current: ReasoningLevel;
  readonly onChoose: (modelId: string, providerId: string, level: ReasoningLevel) => void;
}

/**
 * The pane's title: the model whose levels it shows. The levels say what the pane is for, and the rail or the search
 * group already names the provider, so it is the short name alone. A long name wraps rather than fading, so the pane
 * always says which model it shows. Keyed by model, it fades in on each change instead of the text jumping.
 */
function ReasoningCaption({ option }: { readonly option: ModelOption }) {
  return (
    <p
      key={optionKey(option.providerId, option.modelId)}
      className="min-w-0 flex-1 py-1 text-body-small break-words text-ink transition-opacity duration-(--duration-standard) ease-(--ease-standard) starting:opacity-0 motion-reduce:transition-none"
    >
      {getSelectedModelPresentation(option.modelId, option.providerId).shortLabel}
    </p>
  );
}

function ReasoningPane({ option, selected, reasoning }: { readonly option: ModelOption; readonly selected: boolean; readonly reasoning: ModelPickerReasoning }) {
  const levels = getReasoningLevels(option.providerId, option.modelId);
  const declaredDefault = findProviderModel(option.providerId, option.modelId)?.defaultReasoningLevel;
  // A model without levels keeps the list mounted and folded, so moving to or from it folds the rows like any other move.
  return (
    <>
      <ReasoningLevelOptions
        levels={levels}
        checked={selected ? reasoning.current : undefined}
        defaultLevel={levels.find((level) => level === declaredDefault)}
        listInset
        label={`Reasoning for ${option.label}`}
        onChoose={(level) => reasoning.onChoose(option.modelId, option.providerId, level)}
      />
      <AnimatedCollapsible open={levels.length === 0}>
        <p className="px-2 py-1.5 text-caption text-muted">No reasoning levels</p>
      </AnimatedCollapsible>
    </>
  );
}

/**
 * The model picker body: a {@link Picker} with a Favourites tab and one tab per provider. A provider-locked thread
 * keeps only its provider's tab. Mounting is opening: the tab starts on the selected provider and catalogs load.
 */
export function ModelPickerPanel({
  selectedModelId,
  selectedProviderId,
  providerLocked,
  query,
  onQueryChange,
  tab,
  onTabChange,
  onSelect,
  footer,
  reasoning,
  lead,
}: ModelPickerPanelProps) {
  const presentation = getSelectedModelPresentation(selectedModelId, selectedProviderId);
  const { displayProvider } = presentation;
  const defaultTab = providerLocked && displayProvider
    ? displayProvider.id
    : getDefaultProviderId(selectedProviderId, displayProvider);
  const [activeTab, setActiveTab] = usePickerTab(defaultTab, tab, onTabChange);
  const [legacyFold, setLegacyFold] = useState<LegacyFoldState>("auto");

  const favorites = useModelFavoritesStore((store) => store.entries);
  const toggleFavorite = useModelFavoritesStore((store) => store.toggleFavorite);
  const availabilityList = useProviderAvailabilityStore((store) => store.providers);
  const { getModels, loading: loadingByProvider, fetchModels } = useProviderModelCatalog();

  const canUseProvider = useCallback(
    (providerId: string) => isProviderUsable(providerId, availabilityList),
    [availabilityList],
  );
  const isProviderDisabled = useCallback(
    (providerId: string) => getProviderDisabled(providerId, availabilityList),
    [availabilityList],
  );
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

  const searching = tokenizeSearch(query).length > 0;
  const searchedProviders = useMemo(
    () => (searching ? getProvidersForLeftRail(providerLocked, displayProvider).filter((provider) => !provider.comingSoon && canUseProvider(provider.id)) : []),
    [searching, providerLocked, displayProvider, canUseProvider],
  );

  const selectedModelInTab = presentation.selectedProviderId === activeTab ? presentation.normalizedModelId : undefined;
  const catalogResults = useMemo((): ModelSearchResults => {
    if (activeTab === FAVORITES_TAB) {
      return { options: favoriteModelOptions(filterFavoritesBySearchQuery(favoritesVisible, query), getModels) };
    }
    const provider = MODEL_PROVIDERS.find((entry) => entry.id === activeTab);
    if (!provider) return { options: [] };
    const models = getModels(provider);
    const legacyExpanded = isLegacyFoldExpanded(legacyFold, models, selectedModelInTab);
    const own = providerModelOptions(provider.id, models, query, legacyExpanded);
    return searchAcrossProviders(provider, own, searchedProviders, getModels, query);
  }, [activeTab, favoritesVisible, getModels, query, legacyFold, selectedModelInTab, searchedProviders]);
  const results = useMemo(() => withLead(catalogResults, lead, query), [catalogResults, lead, query]);

  const selectedKey = selectedRowKey(lead, presentation);
  const renderItem = useCallback(
    (option: ModelPickerOption): PickerRow => {
      if (option.kind === "legacy-fold") return legacyFoldRow(option);
      // Its own group, so a divider parts it from the catalog below.
      if (option.kind === "lead") return { key: LEAD_KEY, name: option.label, group: LEAD_KEY };
      const key = optionKey(option.providerId, option.modelId);
      const starred = starredKeys.has(key);
      return {
        key,
        name: option.label,
        group: option.group,
        groupLabel: option.groupLabel,
        disabled: option.endedOn !== undefined,
        disabledReason: option.endedOn && `Subscription access to ${option.label} ended on ${option.endedOn}.`,
        description: option.showProvider ? (
          <>
            <ProviderIcon provider={option.providerId} size={12} />
            <span className="min-w-0 text-fade">{providerName(option.providerId)}</span>
          </>
        ) : undefined,
        // A model whose access ended can still be unstarred, but not newly starred.
        action: option.endedOn && !starred ? undefined : favoriteAction(option, starred, toggleFavorite),
      };
    },
    [starredKeys, toggleFavorite],
  );

  const detail = useMemo((): PickerDetail<ModelPickerOption> | undefined => {
    if (!reasoning) return undefined;
    const hasPane = (option: ModelPickerOption): option is ModelOption => option.kind === "model" && !option.endedOn;
    return {
      hint: "Right Arrow: reasoning level",
      caption: (option) => hasPane(option) ? <ReasoningCaption option={option} /> : null,
      render: (option) => hasPane(option)
        ? <ReasoningPane option={option} selected={optionKey(option.providerId, option.modelId) === selectedKey} reasoning={reasoning} />
        : null,
    };
  }, [reasoning, selectedKey]);

  const showTab = useCallback((next: ModelPickerTab) => {
    setActiveTab(next);
    setLegacyFold("auto");
  }, [setActiveTab]);

  useFetchProviderModels(activeTab, favoritesVisible, searchedProviders, fetchModels);

  const handlePick = (option: ModelPickerOption) => {
    if (option.kind === "legacy-fold") {
      setLegacyFold(option.expanded ? "closed" : "open");
      return;
    }
    if (option.kind === "lead") {
      lead?.onSelect();
      return;
    }
    onSelect(option.modelId, option.providerId);
  };

  const loading = activeTab !== FAVORITES_TAB && (loadingByProvider[activeTab] ?? false);
  return (
    <Picker
      numberedShortcuts
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={showTab}
      query={query}
      onQueryChange={onQueryChange}
      searchPlaceholder="Search models"
      items={results.options}
      unmatchedGroup={results.unmatched}
      total={null}
      status={loading ? "loading" : "ready"}
      selectedKey={selectedKey}
      renderItem={renderItem}
      onSelect={handlePick}
      footer={footer}
      detail={detail}
      hairlines={false}
    />
  );
}
