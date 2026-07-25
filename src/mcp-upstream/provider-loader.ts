import type { ActionExecutor, CredentialValidators, ExecutionResult, ResolvedCredential } from "../core/types.ts";
import type { ProviderProxyExecutor } from "../core/types.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { IUpstreamMcpClient } from "./mcp-client.ts";
import type { IUpstreamMcpServerStore } from "./mcp-server-store.ts";
import type { UpstreamMcpServer } from "./types.ts";

import { hashUpstreamMcpToolContract } from "./contract.ts";
import { UpstreamMcpClientError } from "./mcp-client.ts";

/**
 * Provider loader that delegates generated providers to the static registry and
 * resolves configured MCP servers from runtime storage.
 */
export class UpstreamMcpProviderLoader implements IProviderLoader {
  private readonly base: IProviderLoader;
  private readonly client: IUpstreamMcpClient;
  private readonly store: IUpstreamMcpServerStore;

  constructor(input: { base: IProviderLoader; client: IUpstreamMcpClient; store: IUpstreamMcpServerStore }) {
    this.base = input.base;
    this.client = input.client;
    this.store = input.store;
  }

  async loadActionExecutor(
    service: string,
    actionId: string,
    providerDisplayName?: string,
  ): Promise<ActionExecutor | undefined> {
    const upstream = await this.store.getServerWithTools(service);
    if (!upstream) {
      return await this.base.loadActionExecutor(service, actionId, providerDisplayName);
    }
    const tool = upstream.server.enabled
      ? upstream.tools.find(
          (candidate) =>
            candidate.enabled && candidate.status === "available" && `${service}.${candidate.actionName}` === actionId,
        )
      : undefined;
    if (!tool) {
      return undefined;
    }
    return async (input, context): Promise<ExecutionResult> => {
      if (!isRecord(input)) {
        return {
          ok: false,
          error: { code: "invalid_input", message: "Upstream MCP tool input must be an object." },
        };
      }
      const current = await this.store.getServerWithTools(service);
      const currentTool = current?.server.enabled
        ? current.tools.find(
            (candidate) =>
              candidate.enabled &&
              candidate.status === "available" &&
              candidate.actionName === tool.actionName &&
              candidate.contractHash === tool.contractHash,
          )
        : undefined;
      if (!current || !currentTool) {
        return {
          ok: false,
          error: {
            code: "action_unavailable",
            message: "The upstream MCP tool is disabled or its contract changed.",
          },
        };
      }
      try {
        const credential = await context.getCredential(service);
        return {
          ok: true,
          output: await this.client.callTool(current.server, credential, currentTool.upstreamName, input),
        };
      } catch (error) {
        return toExecutionFailure(error);
      }
    };
  }

  async loadProxyExecutor(service: string, providerDisplayName?: string): Promise<ProviderProxyExecutor | undefined> {
    return (await this.store.getServer(service))
      ? undefined
      : await this.base.loadProxyExecutor(service, providerDisplayName);
  }

  async loadCredentialValidators(service: string): Promise<CredentialValidators | undefined> {
    const server = await this.store.getServer(service);
    if (!server) {
      return await this.base.loadCredentialValidators(service);
    }
    if (server.auth.type === "none") {
      return undefined;
    }
    return {
      apiKey: async (input) => {
        const discovered = await this.client.discoverTools(
          server,
          createValidationCredential(server, input.apiKey, input.values),
        );
        await this.assertCompatibleContract(service, discovered);
        return {
          profile: {
            accountId: server.service,
            displayName: server.displayName,
            grantedScopes: [],
          },
        };
      },
    };
  }

  private async assertCompatibleContract(
    service: string,
    discovered: Awaited<ReturnType<IUpstreamMcpClient["discoverTools"]>>,
  ): Promise<void> {
    const current = await this.store.getServerWithTools(service);
    const expected = current?.tools.filter((tool) => tool.status !== "removed") ?? [];
    if (expected.length === 0) {
      return;
    }
    const actual = new Map(
      await Promise.all(discovered.map(async (tool) => [tool.name, await hashUpstreamMcpToolContract(tool)] as const)),
    );
    const compatible =
      actual.size === expected.length && expected.every((tool) => actual.get(tool.upstreamName) === tool.contractHash);
    if (!compatible) {
      throw new UpstreamMcpClientError(
        "tool_contract_mismatch",
        `${current?.server.displayName ?? service} connection exposes a different MCP tool contract.`,
      );
    }
  }
}

function createValidationCredential(
  server: UpstreamMcpServer,
  apiKey: string,
  values: Record<string, string>,
): ResolvedCredential {
  return {
    authType: "api_key",
    apiKey,
    values,
    profile: {
      accountId: server.service,
      displayName: server.displayName,
      grantedScopes: [],
    },
    metadata: {},
  };
}

function toExecutionFailure(error: unknown): ExecutionResult {
  if (error instanceof UpstreamMcpClientError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "upstream_request_failed",
      message: error instanceof Error ? error.message : "Upstream MCP request failed.",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
