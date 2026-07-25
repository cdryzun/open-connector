import type { CatalogStore } from "../catalog-store.ts";
import type { ActionDefinition, ProviderDefinition, ProviderAuthDefinition } from "../core/types.ts";
import type { IUpstreamMcpServerStore } from "./mcp-server-store.ts";
import type { UpstreamMcpServer, UpstreamMcpServerWithTools } from "./types.ts";

import { replaceDynamicProviders } from "../catalog-store.ts";

const unconstrainedOutputSchema = {};

/**
 * Reload enabled upstream MCP servers into the runtime provider catalog.
 */
export async function refreshUpstreamMcpCatalog(catalog: CatalogStore, store: IUpstreamMcpServerStore): Promise<void> {
  const servers = await store.listServers();
  const upstreams = (
    await Promise.all(
      servers.map(async (server) => {
        const upstream = await store.getServerWithTools(server.service);
        return upstream
          ? {
              server,
              tools: server.enabled ? upstream.tools.filter((tool) => tool.enabled && tool.status === "available") : [],
            }
          : undefined;
      }),
    )
  ).filter((upstream): upstream is UpstreamMcpServerWithTools => upstream !== undefined);
  const providers = upstreams.map(toProviderDefinition);
  const executableActionIds = providers.flatMap((provider) => provider.actions.map((action) => action.id));
  replaceDynamicProviders(catalog, providers, executableActionIds);
}

export function toProviderDefinition(input: UpstreamMcpServerWithTools): ProviderDefinition {
  return {
    service: input.server.service,
    displayName: input.server.displayName,
    description: input.server.description ?? `Tools provided by ${input.server.endpoint}.`,
    categories: ["mcp"],
    authTypes: [input.server.auth.type === "none" ? "no_auth" : "api_key"],
    auth: [toAuthDefinition(input.server)],
    actions: input.tools.map(
      (tool): ActionDefinition => ({
        id: `${input.server.service}.${tool.actionName}`,
        service: input.server.service,
        name: tool.actionName,
        description: tool.description ?? tool.title ?? `Run upstream MCP tool ${tool.upstreamName}.`,
        requiredScopes: [],
        providerPermissions: [],
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? unconstrainedOutputSchema,
      }),
    ),
  };
}

function toAuthDefinition(server: UpstreamMcpServer): ProviderAuthDefinition {
  if (server.auth.type === "none") {
    return { type: "no_auth" };
  }
  if (server.auth.type === "bearer") {
    return {
      type: "api_key",
      label: "Bearer token",
      placeholder: "Enter bearer token",
      description: `Bearer token sent to ${server.displayName}.`,
    };
  }
  return {
    type: "api_key",
    label: server.auth.headerName,
    placeholder: `Enter ${server.auth.headerName} value`,
    description: `API key sent in the ${server.auth.headerName} header.`,
  };
}
