import type { ActionDefinition, AuthType, ProviderDefinition } from "./core/types.ts";

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sortProviders } from "./core/catalog.ts";

export type ActionExecutionStatus = {
  locallyExecutable: boolean;
  catalogOnly: boolean;
  requiredAuthTypes: AuthType[];
  noAuthRunnable: boolean;
  needsCredential: boolean;
};

export type RuntimeActionDefinition = ActionDefinition & {
  execution: ActionExecutionStatus;
};

export type RuntimeCatalogSource = "provider" | "upstream_mcp";

export type RuntimeProviderDefinition = Omit<ProviderDefinition, "actions"> & {
  catalogSource: RuntimeCatalogSource;
  actions: RuntimeActionDefinition[];
  execution: {
    actionCount: number;
    locallyExecutableActionCount: number;
    catalogOnlyActionCount: number;
  };
};

/**
 * Action without its JSON schemas.
 *
 * `inputSchema`/`outputSchema` are ~85% of the serialized catalog but are only
 * needed by the single action detail view, which fetches the full action from
 * `/api/actions/:actionId`. List views read metadata only.
 */
export type ActionSummaryDefinition = Omit<RuntimeActionDefinition, "inputSchema" | "outputSchema">;

export type ProviderSummaryDefinition = Omit<RuntimeProviderDefinition, "actions"> & {
  actions: ActionSummaryDefinition[];
};

/**
 * In-memory view of generated catalog JSON.
 *
 * `actionsById` is built at load time so request handlers do not repeatedly
 * scan every provider.
 */
export type CatalogStore = {
  /** Monotonic in-process revision used to invalidate derived search indexes. */
  revision: number;
  providers: RuntimeProviderDefinition[];
  /**
   * Schema-free view of `providers`, recomputed when the runtime catalog
   * revision changes. Served by `/api/providers` so the dashboard does not
   * download every action schema on load.
   */
  providerSummaries: ProviderSummaryDefinition[];
  /**
   * `providerSummaries` pre-serialized for the current revision. Served verbatim by
   * `/api/providers` so the response is neither re-serialized per request nor
   * able to drift from {@link providerSummariesEtag}.
   */
  providerSummariesJson: string;
  /**
   * Content-derived ETag for the current provider summaries. It lets
   * `/api/providers` answer conditional requests with `304 Not Modified`.
   */
  providerSummariesEtag: string;
  actions: RuntimeActionDefinition[];
  actionsById: Map<string, RuntimeActionDefinition>;
  executableActionIds: Set<string>;
  /** Runtime-only aliases for resolving upstream MCP slugs to canonical service ids. */
  serviceAliases: ReadonlyMap<string, string>;
};

export interface LoadCatalogOptions {
  executableActionIds?: Iterable<string>;
}

interface StaticCatalogState {
  providers: ProviderDefinition[];
  executableActionIds: Set<string>;
}

export interface DynamicProviderRegistration {
  provider: ProviderDefinition;
  aliases: readonly string[];
}

export interface ReplaceDynamicProvidersInput {
  registrations: readonly DynamicProviderRegistration[];
  executableActionIds: Iterable<string>;
}

const staticCatalogStates = new WeakMap<CatalogStore, StaticCatalogState>();

export function createCatalogStore(providers: ProviderDefinition[], options: LoadCatalogOptions = {}): CatalogStore {
  const executableActionIds = new Set(options.executableActionIds ?? []);
  const catalog = buildCatalogStore(providers, [], executableActionIds, 0);
  staticCatalogStates.set(catalog, {
    providers: [...providers],
    executableActionIds,
  });
  return catalog;
}

/**
 * Replace all runtime-defined providers while retaining the generated catalog.
 *
 * The store object is updated in place so long-lived services observe the same
 * catalog revision without rebuilding their dependency graph.
 */
export function replaceDynamicProviders(catalog: CatalogStore, input: ReplaceDynamicProvidersInput): void {
  const staticState = staticCatalogStates.get(catalog);
  if (!staticState) {
    throw new Error("Catalog store was not created by createCatalogStore.");
  }
  const staticServices = new Set(staticState.providers.map((provider) => provider.service));
  for (const registration of input.registrations) {
    if (staticServices.has(registration.provider.service)) {
      throw new Error(`Dynamic provider service conflicts with the static catalog: ${registration.provider.service}.`);
    }
  }
  const nextExecutableActionIds = new Set([...staticState.executableActionIds, ...input.executableActionIds]);
  const next = buildCatalogStore(
    staticState.providers,
    input.registrations,
    nextExecutableActionIds,
    catalog.revision + 1,
  );
  Object.assign(catalog, next);
}

function buildCatalogStore(
  staticProviders: ProviderDefinition[],
  dynamicRegistrations: readonly DynamicProviderRegistration[],
  executableActions: Set<string>,
  revision: number,
): CatalogStore {
  const dynamicProviders = dynamicRegistrations.map((registration) => registration.provider);
  const dynamicServices = new Set(dynamicProviders.map((provider) => provider.service));
  const serviceAliases = buildServiceAliases(dynamicRegistrations);
  const providers = [...staticProviders, ...dynamicProviders];
  const sortedProviders = sortProviders(providers);
  const runtimeProviders = sortedProviders.map((provider): RuntimeProviderDefinition => {
    const actions = provider.actions.map(
      (action): RuntimeActionDefinition => ({
        ...action,
        execution: createActionExecutionStatus(provider, action, executableActions),
      }),
    );

    return {
      ...provider,
      catalogSource: dynamicServices.has(provider.service) ? "upstream_mcp" : "provider",
      actions,
      execution: {
        actionCount: actions.length,
        locallyExecutableActionCount: actions.filter((action) => action.execution.locallyExecutable).length,
        catalogOnlyActionCount: actions.filter((action) => action.execution.catalogOnly).length,
      },
    };
  });
  const actions = runtimeProviders.flatMap((provider) => provider.actions);
  const providerSummaries = runtimeProviders.map(toProviderSummary);
  const providerSummariesJson = JSON.stringify(providerSummaries);

  return {
    revision,
    providers: runtimeProviders,
    providerSummaries,
    providerSummariesJson,
    providerSummariesEtag: weakEtag(providerSummariesJson),
    actions,
    actionsById: new Map(actions.map((action) => [action.id, action])),
    executableActionIds: executableActions,
    serviceAliases,
  };
}

function buildServiceAliases(registrations: readonly DynamicProviderRegistration[]): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const registration of registrations) {
    for (const alias of registration.aliases) {
      const normalized = normalizeServiceAlias(alias);
      const existing = aliases.get(normalized);
      if (existing && existing !== registration.provider.service) {
        throw new Error(`Dynamic provider alias is ambiguous: ${alias}.`);
      }
      aliases.set(normalized, registration.provider.service);
    }
  }
  return aliases;
}

function normalizeServiceAlias(alias: string): string {
  const normalized = alias.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Dynamic provider aliases must not be empty.");
  }
  return normalized;
}

/**
 * Resolve a canonical provider service or a unique upstream MCP slug alias.
 *
 * Exact catalog services always win, preserving stable provider behavior when
 * an older upstream MCP registration later overlaps with a static provider.
 */
export function resolveCatalogService(catalog: CatalogStore, requestedService: string): string | undefined {
  const requested = requestedService.trim();
  const exact = catalog.providers.find((provider) => provider.service === requested);
  return exact?.service ?? catalog.serviceAliases.get(requested.toLowerCase());
}

/**
 * Content-derived ETag using a pure-JS FNV-1a hash. Runtime-agnostic (no
 * `node:crypto`, so the Cloudflare Workers build shares this path) and computed
 * once per catalog revision. Emitted as a weak validator because the response
 * body may be gzip-transformed downstream.
 */
function weakEtag(content: string): string {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  const digest = (hash >>> 0).toString(16).padStart(8, "0");
  return `W/"${content.length.toString(16)}-${digest}"`;
}

function toProviderSummary(provider: RuntimeProviderDefinition): ProviderSummaryDefinition {
  return {
    ...provider,
    actions: provider.actions.map(({ inputSchema: _inputSchema, outputSchema: _outputSchema, ...action }) => action),
  };
}

/**
 * Load generated provider catalog files from disk.
 */
export async function loadCatalog(
  catalogDir: string = join(process.cwd(), "catalog/apps"),
  options: LoadCatalogOptions = {},
): Promise<CatalogStore> {
  const entries = await readdir(catalogDir, { withFileTypes: true });
  const providers = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const content = await readFile(join(catalogDir, entry.name), "utf8");
        return JSON.parse(content) as ProviderDefinition;
      }),
  );
  return createCatalogStore(providers, options);
}

function createActionExecutionStatus(
  provider: ProviderDefinition,
  action: ActionDefinition,
  executableActions: Set<string>,
): ActionExecutionStatus {
  const locallyExecutable = executableActions.has(action.id);
  return {
    locallyExecutable,
    catalogOnly: !locallyExecutable,
    requiredAuthTypes: provider.authTypes,
    noAuthRunnable: provider.authTypes.includes("no_auth"),
    needsCredential: !provider.authTypes.includes("no_auth"),
  };
}
