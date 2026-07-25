import type { ProviderDefinition } from "./core/types.ts";

import { describe, expect, it } from "vitest";
import { createCatalogStore, replaceDynamicProviders, resolveCatalogService } from "./catalog-store.ts";

describe("catalog store", () => {
  it("preserves optional provider descriptions without defaulting missing ones", () => {
    const providers: ProviderDefinition[] = [
      {
        service: "described",
        displayName: "Described",
        description: "A provider-level summary.",
        categories: ["Developer Tools"],
        authTypes: ["no_auth"],
        auth: [{ type: "no_auth" }],
        actions: [],
      },
      {
        service: "plain",
        displayName: "Plain",
        categories: ["Developer Tools"],
        authTypes: ["no_auth"],
        auth: [{ type: "no_auth" }],
        actions: [],
      },
    ];

    const catalog = createCatalogStore(providers);

    expect(catalog.providers.find((provider) => provider.service === "described")?.description).toBe(
      "A provider-level summary.",
    );
    expect(catalog.providers.find((provider) => provider.service === "plain")).not.toHaveProperty("description");
  });

  it("builds provider summaries that drop action schemas but keep metadata", () => {
    const providers: ProviderDefinition[] = [
      {
        service: "example",
        displayName: "Example",
        categories: ["Developer Tools"],
        authTypes: ["no_auth"],
        auth: [{ type: "no_auth" }],
        actions: [
          {
            id: "example.ping",
            service: "example",
            name: "ping",
            description: "Ping the service.",
            requiredScopes: ["read"],
            providerPermissions: [],
            inputSchema: { type: "object", properties: { message: { type: "string" } } },
            outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
          },
        ],
      },
    ];

    const catalog = createCatalogStore(providers, { executableActionIds: ["example.ping"] });
    const summary = catalog.providerSummaries[0];
    const summarizedAction = summary?.actions[0];

    expect(summarizedAction).not.toHaveProperty("inputSchema");
    expect(summarizedAction).not.toHaveProperty("outputSchema");
    expect(summarizedAction?.id).toBe("example.ping");
    expect(summarizedAction?.requiredScopes).toEqual(["read"]);
    expect(summarizedAction?.execution.locallyExecutable).toBe(true);
    expect(summary?.execution.actionCount).toBe(1);
    // The full catalog still carries schemas for /api/actions/:actionId.
    expect(catalog.actionsById.get("example.ping")?.inputSchema).toEqual({
      type: "object",
      properties: { message: { type: "string" } },
    });
  });

  it("tracks upstream MCP catalog entries separately and resolves their slug aliases", () => {
    const staticProvider: ProviderDefinition = {
      service: "example",
      displayName: "Static Example",
      categories: ["Developer Tools"],
      authTypes: ["no_auth"],
      auth: [{ type: "no_auth" }],
      actions: [],
    };
    const upstreamProvider: ProviderDefinition = {
      service: "mcp_teambition",
      displayName: "Teambition MCP",
      categories: ["mcp"],
      authTypes: ["api_key"],
      auth: [{ type: "api_key" }],
      actions: [],
    };
    const catalog = createCatalogStore([staticProvider]);

    replaceDynamicProviders(catalog, {
      registrations: [{ provider: upstreamProvider, aliases: ["teambition"] }],
      executableActionIds: [],
    });

    expect(catalog.providers).toMatchObject([
      { service: "example", catalogSource: "provider" },
      { service: "mcp_teambition", catalogSource: "upstream_mcp" },
    ]);
    expect(resolveCatalogService(catalog, "example")).toBe("example");
    expect(resolveCatalogService(catalog, "teambition")).toBe("mcp_teambition");
    expect(resolveCatalogService(catalog, "mcp_teambition")).toBe("mcp_teambition");
    expect(resolveCatalogService(catalog, "missing")).toBeUndefined();
  });
});
