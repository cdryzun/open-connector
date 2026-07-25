import type { ResolvedCredential } from "../core/types.ts";
import type { IUpstreamMcpClient } from "../mcp-upstream/mcp-client.ts";
import type { DiscoveredMcpTool, UpstreamMcpServer } from "../mcp-upstream/types.ts";
import type { ITransitFileService, TransitFileRead, TransitFileUpload } from "./files/transit-file-store.ts";

import { afterEach, describe, expect, it } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { ProviderLoader } from "../providers/provider-loader.ts";
import { createConnectApp } from "./connect-app.ts";
import { PlainTextSecretCodec } from "./secrets/secret-codec-core.ts";
import { SqliteRuntimeDatabase } from "./storage/sqlite-runtime-store.ts";

const databases: SqliteRuntimeDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe("createConnectApp upstream MCP integration", () => {
  it("registers, reviews, publishes, and executes an upstream MCP tool", async () => {
    const client = new TestMcpClient([
      {
        name: "lookup",
        description: "Look up one record.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ]);
    const database = new SqliteRuntimeDatabase(":memory:");
    databases.push(database);
    const { app } = await createConnectApp({
      catalog: createCatalogStore([]),
      providerLoader: new ProviderLoader({}),
      runtimeDatabase: database,
      transitFiles: new UnusedTransitFileService(),
      publicOrigin: "http://localhost:3000",
      secretCodec: new PlainTextSecretCodec(),
      upstreamMcpClient: client,
    });

    const createdResponse = await app.request("/api/mcp-servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "example",
        displayName: "Example MCP",
        endpoint: "https://mcp.example.com/mcp",
        auth: { type: "none" },
      }),
    });
    expect(createdResponse.status).toBe(201);
    await expect(createdResponse.json()).resolves.toMatchObject({
      server: { service: "mcp_example", revision: 2, syncStatus: "ok" },
      tools: [{ upstreamName: "lookup", enabled: false, status: "available" }],
    });

    const selectionResponse = await app.request("/api/mcp-servers/mcp_example/tools", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 2,
        enabledTools: ["lookup"],
      }),
    });
    expect(selectionResponse.status).toBe(200);

    const actionResponse = await app.request("/v1/actions/mcp_example.lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { id: "record-1" } }),
    });
    expect(actionResponse.status).toBe(200);
    await expect(actionResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        toolName: "lookup",
        input: { id: "record-1" },
      },
    });
    expect(client.calls).toEqual([{ service: "mcp_example", toolName: "lookup", input: { id: "record-1" } }]);

    client.tools = [
      {
        name: "lookup",
        description: "Look up one record with expanded fields.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ];
    const syncResponse = await app.request("/api/mcp-servers/mcp_example/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(syncResponse.status).toBe(200);
    await expect(syncResponse.json()).resolves.toMatchObject({ changed: 1 });

    const actionsAfterChange = await app.request("/api/actions");
    await expect(actionsAfterChange.json()).resolves.toEqual([]);
    const toolsAfterChange = await app.request("/api/mcp-servers/mcp_example/tools");
    await expect(toolsAfterChange.json()).resolves.toMatchObject({
      tools: [{ upstreamName: "lookup", enabled: false, status: "review_required" }],
    });
  });
});

class TestMcpClient implements IUpstreamMcpClient {
  tools: DiscoveredMcpTool[];
  readonly calls: Array<{ service: string; toolName: string; input: Record<string, unknown> }> = [];

  constructor(tools: DiscoveredMcpTool[]) {
    this.tools = tools;
  }

  async discoverTools(): Promise<DiscoveredMcpTool[]> {
    return structuredClone(this.tools);
  }

  async callTool(
    server: UpstreamMcpServer,
    _credential: ResolvedCredential | undefined,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push({ service: server.service, toolName, input });
    return { toolName, input };
  }
}

class UnusedTransitFileService implements ITransitFileService {
  readonly maxBytes = 1024;

  async create(_file: File): Promise<TransitFileUpload> {
    throw new Error("Unexpected transit file create.");
  }

  async read(_fileId: string): Promise<TransitFileRead> {
    throw new Error("Unexpected transit file read.");
  }

  async delete(_fileId: string): Promise<boolean> {
    throw new Error("Unexpected transit file delete.");
  }

  async cleanupExpired(): Promise<void> {}
}
