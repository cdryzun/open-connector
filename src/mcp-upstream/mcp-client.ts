import type { ResolvedCredential } from "../core/types.ts";
import type { DiscoveredMcpTool, UpstreamMcpServer } from "./types.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { isPrivateNetworkAccessAllowed } from "../core/request.ts";
import { createProviderFetch, ProviderRequestError, providerUserAgent } from "../providers/provider-runtime.ts";

const maxListPages = 20;
const maxTools = 500;
const maxToolBytes = 256 * 1024;
const maxTotalToolBytes = 5 * 1024 * 1024;
const requestTimeoutMs = 120_000;

export interface IUpstreamMcpClient {
  discoverTools(server: UpstreamMcpServer, credential?: ResolvedCredential): Promise<DiscoveredMcpTool[]>;
  callTool(
    server: UpstreamMcpServer,
    credential: ResolvedCredential | undefined,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
}

/**
 * Streamable HTTP MCP client with bounded discovery and SSRF-guarded egress.
 */
export class UpstreamMcpClient implements IUpstreamMcpClient {
  async discoverTools(server: UpstreamMcpServer, credential?: ResolvedCredential): Promise<DiscoveredMcpTool[]> {
    return await this.withClient(server, credential, async (client) => {
      const tools: DiscoveredMcpTool[] = [];
      let cursor: string | undefined;
      let totalBytes = 0;
      for (let page = 0; page < maxListPages; page++) {
        const result = await client.request(
          {
            method: "tools/list",
            params: cursor ? { cursor } : {},
          },
          ListToolsResultSchema,
          { timeout: requestTimeoutMs },
        );
        for (const tool of result.tools) {
          const bytes = jsonByteLength(tool);
          if (bytes > maxToolBytes) {
            throw new UpstreamMcpClientError(
              "tool_contract_too_large",
              `MCP tool ${tool.name} exceeds the ${maxToolBytes} byte contract limit.`,
            );
          }
          totalBytes += bytes;
          if (totalBytes > maxTotalToolBytes) {
            throw new UpstreamMcpClientError(
              "catalog_too_large",
              `MCP tool catalog exceeds the ${maxTotalToolBytes} byte limit.`,
            );
          }
          tools.push({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations,
          });
          if (tools.length > maxTools) {
            throw new UpstreamMcpClientError("too_many_tools", `MCP server exposes more than ${maxTools} tools.`);
          }
        }
        cursor = result.nextCursor;
        if (!cursor) {
          return tools;
        }
      }
      throw new UpstreamMcpClientError("too_many_pages", `MCP tools/list exceeded the ${maxListPages} page limit.`);
    });
  }

  async callTool(
    server: UpstreamMcpServer,
    credential: ResolvedCredential | undefined,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    return await this.withClient(server, credential, async (client) => {
      const result = await client.request(
        {
          method: "tools/call",
          params: { name: toolName, arguments: input },
        },
        CallToolResultSchema,
        { timeout: requestTimeoutMs },
      );
      return normalizeToolResult(server.displayName, toolName, result);
    });
  }

  private async withClient<T>(
    server: UpstreamMcpServer,
    credential: ResolvedCredential | undefined,
    run: (client: Client) => Promise<T>,
  ): Promise<T> {
    const headers = createHeaders(server, credential);
    const sensitiveHeaders = server.auth.type === "api_key_header" ? [server.auth.headerName] : [];
    const fetcher = createProviderFetch({
      allowPrivateNetwork: isPrivateNetworkAccessAllowed,
      sensitiveHeaders,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    const transport = new StreamableHTTPClientTransport(new URL(server.endpoint), {
      fetch: fetcher,
      requestInit: { headers, signal: controller.signal },
    });
    const client = new Client({ name: "oomol-connect-upstream-mcp", version: "1.0.0" });

    try {
      await client.connect(transport, { timeout: requestTimeoutMs });
      return await run(client);
    } catch (error) {
      throw mapClientError(server.displayName, error);
    } finally {
      clearTimeout(timeout);
      await client.close().catch(() => undefined);
    }
  }
}

export class UpstreamMcpClientError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function createHeaders(server: UpstreamMcpServer, credential: ResolvedCredential | undefined): Headers {
  const headers = new Headers({ "user-agent": providerUserAgent });
  if (server.auth.type === "none") {
    return headers;
  }
  if (!credential || credential.authType !== "api_key" || !credential.apiKey) {
    throw new UpstreamMcpClientError("connection_required", `${server.displayName} requires a configured credential.`);
  }
  if (server.auth.type === "bearer") {
    headers.set("authorization", `Bearer ${credential.apiKey}`);
  } else {
    headers.set(server.auth.headerName, credential.apiKey);
  }
  return headers;
}

function normalizeToolResult(serverName: string, toolName: string, result: CallToolResult): unknown {
  if (result.isError) {
    throw new UpstreamMcpClientError(
      "upstream_tool_error",
      `${serverName} tool ${toolName} returned an error: ${formatTextContent(result)}`,
      result,
    );
  }
  if (result.structuredContent) {
    return result.structuredContent;
  }
  const textContent = result.content.filter((item) => item.type === "text");
  if (textContent.length === 1) {
    try {
      return JSON.parse(textContent[0]!.text);
    } catch {
      return textContent[0]!.text;
    }
  }
  return result.content;
}

function formatTextContent(result: CallToolResult): string {
  const message = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("; ");
  return message || "unknown upstream error";
}

function mapClientError(serverName: string, error: unknown): UpstreamMcpClientError {
  if (error instanceof UpstreamMcpClientError) {
    return error;
  }
  if (error instanceof UnauthorizedError) {
    return new UpstreamMcpClientError("credential_rejected", `${serverName} MCP credential was rejected.`, error);
  }
  if (error instanceof StreamableHTTPError) {
    return new UpstreamMcpClientError(
      error.code === 401 || error.code === 403 ? "credential_rejected" : "upstream_http_error",
      `${serverName} MCP request failed: ${error.message}`,
      error,
    );
  }
  if (error instanceof ProviderRequestError) {
    return new UpstreamMcpClientError("upstream_network_error", error.message, error.details);
  }
  if (error instanceof McpError) {
    return new UpstreamMcpClientError("upstream_protocol_error", `${serverName} MCP request failed: ${error.message}`);
  }
  return new UpstreamMcpClientError(
    "upstream_request_failed",
    error instanceof Error ? `${serverName} MCP request failed: ${error.message}` : `${serverName} MCP request failed.`,
    error,
  );
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
