import type { ResolvedCredential } from "../core/types.ts";
import type { IUpstreamMcpClient } from "./mcp-client.ts";
import type { DiscoveredMcpTool, UpstreamMcpServer } from "./types.ts";

import { afterEach, describe, expect, it } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { ConnectionService } from "../connection-service.ts";
import { ProviderLoader } from "../providers/provider-loader.ts";
import { SqliteRuntimeDatabase } from "../server/storage/sqlite-runtime-store.ts";
import { UpstreamMcpServerService, UpstreamMcpServerServiceError } from "./mcp-server-service.ts";
import { UpstreamMcpProviderLoader } from "./provider-loader.ts";

const databases: SqliteRuntimeDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe("UpstreamMcpServerService", () => {
  it("keeps new tools disabled, publishes approved tools, and pauses changed contracts", async () => {
    const initialCredential = ["initial", "credential"].join("-");
    const sameContractCredential = ["same", "contract"].join("-");
    const differentContractCredential = ["different", "contract"].join("-");
    const client = new TestMcpClient([
      {
        name: "search-records",
        description: "Search records.",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);
    const { catalog, database, service } = createService(client);

    const created = await service.createServer(
      {
        slug: "example",
        displayName: "Example MCP",
        endpoint: "https://mcp.example.com/mcp",
        auth: { type: "bearer" },
      },
      { credential: initialCredential },
    );

    expect(created.server.revision).toBe(2);
    expect(created.tools).toMatchObject([
      {
        upstreamName: "search-records",
        enabled: false,
        status: "available",
      },
    ]);
    expect(catalog.actions).toEqual([]);

    await service.setEnabledTools(created.server.service, {
      expectedRevision: created.server.revision,
      enabledTools: ["search-records"],
    });
    expect(catalog.actions.map((action) => action.id)).toEqual(["mcp_example.search_records"]);
    const providerLoader = new UpstreamMcpProviderLoader({
      base: new ProviderLoader({}),
      client,
      store: database.upstreamMcpServerStore,
    });
    const executor = await providerLoader.loadActionExecutor(created.server.service, "mcp_example.search_records");
    await expect(
      executor?.(
        { query: "example" },
        {
          getCredential: async () => ({
            authType: "api_key",
            apiKey: initialCredential,
            values: { apiKey: initialCredential },
            profile: { accountId: "mcp_example", displayName: "Example MCP", grantedScopes: [] },
            metadata: {},
          }),
        },
      ),
    ).resolves.toEqual({
      ok: true,
      output: { toolName: "search-records", input: { query: "example" } },
    });
    const validators = await providerLoader.loadCredentialValidators(created.server.service);
    await expect(
      validators?.apiKey?.(
        { apiKey: sameContractCredential, values: { apiKey: sameContractCredential } },
        { fetcher: fetch },
      ),
    ).resolves.toMatchObject({
      profile: { accountId: created.server.service },
    });

    const endpointUpdated = await service.updateServer(
      created.server.service,
      { endpoint: "https://mcp.example.com/v2/mcp" },
      { sync: false },
    );
    expect(endpointUpdated.tools).toMatchObject([{ upstreamName: "search-records", enabled: false }]);
    expect(catalog.actions).toEqual([]);
    await expect(
      executor?.(
        { query: "stale" },
        {
          getCredential: async () => undefined,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "action_unavailable" },
    });
    await service.setEnabledTools(created.server.service, {
      expectedRevision: endpointUpdated.server.revision,
      enabledTools: ["search-records"],
    });

    client.tools = [
      {
        name: "search-records",
        description: "Search records with filters.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
        },
      },
    ];
    await expect(
      validators?.apiKey?.(
        { apiKey: differentContractCredential, values: { apiKey: differentContractCredential } },
        { fetcher: fetch },
      ),
    ).rejects.toMatchObject({
      code: "tool_contract_mismatch",
    });
    await service.syncServer(created.server.service);
    const changed = await service.getServer(created.server.service);

    expect(changed.tools).toMatchObject([
      {
        upstreamName: "search-records",
        enabled: false,
        status: "review_required",
      },
    ]);
    expect(catalog.actions).toEqual([]);
  });

  it("marks tools removed upstream and records duplicate-name sync failures", async () => {
    const client = new TestMcpClient([
      {
        name: "first",
        inputSchema: { type: "object" },
      },
      {
        name: "second",
        inputSchema: { type: "object" },
      },
    ]);
    const { service } = createService(client);
    const created = await service.createServer({
      slug: "removal",
      displayName: "Removal MCP",
      endpoint: "https://mcp.example.com/mcp",
      auth: { type: "none" },
    });

    client.tools = [{ name: "first", inputSchema: { type: "object" } }];
    await service.syncServer(created.server.service);
    const afterRemoval = await service.getServer(created.server.service);
    expect(afterRemoval.tools.find((tool) => tool.upstreamName === "second")).toMatchObject({
      enabled: false,
      status: "removed",
    });

    client.tools = [
      { name: "first", inputSchema: { type: "object" } },
      { name: "first", inputSchema: { type: "object" } },
    ];
    await expect(service.syncServer(created.server.service)).rejects.toMatchObject({
      code: "duplicate_tool_names",
    });
    await expect(service.getServer(created.server.service)).resolves.toMatchObject({
      server: {
        syncStatus: "error",
        lastSyncError: expect.stringContaining("duplicate tool names"),
      },
    });
  });

  it("rejects unsafe endpoints and custom credential header names", async () => {
    const { service } = createService(new TestMcpClient([]));

    await expect(
      service.createServer({
        slug: "metadata",
        displayName: "Metadata",
        endpoint: "http://169.254.169.254/mcp",
        auth: { type: "none" },
      }),
    ).rejects.toMatchObject({ code: "invalid_endpoint" });

    await expect(
      service.createServer({
        slug: "bad-header",
        displayName: "Bad Header",
        endpoint: "https://mcp.example.com/mcp",
        auth: { type: "api_key_header", headerName: "Host" },
      }),
    ).rejects.toBeInstanceOf(UpstreamMcpServerServiceError);
  });

  it("rejects a dynamic service that conflicts with a static provider", async () => {
    const catalog = createCatalogStore([
      {
        service: "mcp_example",
        displayName: "Static MCP Example",
        categories: ["Developer Tools"],
        authTypes: ["no_auth"],
        auth: [{ type: "no_auth" }],
        actions: [],
      },
    ]);
    const { service } = createService(new TestMcpClient([]), catalog);

    await expect(
      service.createServer({
        slug: "example",
        displayName: "Dynamic MCP Example",
        endpoint: "https://mcp.example.com/mcp",
        auth: { type: "none" },
      }),
    ).rejects.toMatchObject({ code: "mcp_server_conflict" });
  });
});

function createService(client: IUpstreamMcpClient, catalog = createCatalogStore([])) {
  const database = new SqliteRuntimeDatabase(":memory:");
  databases.push(database);
  const connections = new ConnectionService({
    catalog,
    providerLoader: new ProviderLoader({}),
    store: database.connectionStore,
  });
  const service = new UpstreamMcpServerService({
    catalog,
    client,
    connections,
    store: database.upstreamMcpServerStore,
  });
  return { catalog, database, service };
}

class TestMcpClient implements IUpstreamMcpClient {
  tools: DiscoveredMcpTool[];

  constructor(tools: DiscoveredMcpTool[]) {
    this.tools = tools;
  }

  async discoverTools(_server: UpstreamMcpServer, _credential?: ResolvedCredential): Promise<DiscoveredMcpTool[]> {
    return structuredClone(this.tools);
  }

  async callTool(
    _server: UpstreamMcpServer,
    _credential: ResolvedCredential | undefined,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    return { toolName, input };
  }
}
