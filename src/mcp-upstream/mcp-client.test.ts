import type { UpstreamMcpServer } from "./types.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { setDefaultGuardedFetchDnsLookup } from "../core/guarded-fetch.ts";
import { UpstreamMcpClient } from "./mcp-client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setDefaultGuardedFetchDnsLookup(undefined);
});

describe("UpstreamMcpClient", () => {
  it("discovers and executes tools over Streamable HTTP with bearer authentication", async () => {
    const authorizationHeaders: Array<string | null> = [];
    const testCredential = ["test", "credential"].join("-");
    setDefaultGuardedFetchDnsLookup(null);
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      authorizationHeaders.push(request.headers.get("authorization"));

      const server = createTestServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        await server.close();
      }
    };

    const client = new UpstreamMcpClient();
    const server = testServer();
    const credential = {
      authType: "api_key" as const,
      apiKey: testCredential,
      values: { apiKey: testCredential },
      profile: {
        accountId: server.service,
        displayName: server.displayName,
        grantedScopes: [],
      },
      metadata: {},
    };

    await expect(client.discoverTools(server, credential)).resolves.toMatchObject([
      {
        name: "lookup",
        description: "Look up a record.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ]);
    await expect(client.callTool(server, credential, "lookup", { query: "record-1" })).resolves.toEqual({
      query: "record-1",
      found: true,
    });
    expect(authorizationHeaders).not.toContain(null);
    expect(new Set(authorizationHeaders)).toEqual(new Set([`Bearer ${testCredential}`]));
  });
});

function createTestServer(): McpServer {
  const server = new McpServer({
    name: "upstream-mcp-client-test",
    version: "1.0.0",
  });
  server.registerTool(
    "lookup",
    {
      description: "Look up a record.",
      inputSchema: { query: z.string() },
    },
    async ({ query }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ query, found: true }),
        },
      ],
    }),
  );
  return server;
}

function testServer(): UpstreamMcpServer {
  return {
    service: "mcp_test",
    slug: "test",
    displayName: "Test MCP",
    endpoint: "https://mcp.example.com/mcp",
    auth: { type: "bearer" },
    enabled: true,
    revision: 1,
    syncStatus: "never",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
  };
}
