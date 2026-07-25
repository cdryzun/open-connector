import type { CatalogStore } from "../catalog-store.ts";
import type { ConnectionService } from "../connection-service.ts";
import type { IUpstreamMcpClient } from "./mcp-client.ts";
import type { IUpstreamMcpServerStore } from "./mcp-server-store.ts";
import type {
  CreateUpstreamMcpServerInput,
  DiscoveredMcpTool,
  SetUpstreamMcpToolsInput,
  UpdateUpstreamMcpServerInput,
  UpstreamMcpAuth,
  UpstreamMcpServer,
  UpstreamMcpServerWithTools,
  UpstreamMcpSyncResult,
  UpstreamMcpTool,
  UpstreamMcpToolSelectionResult,
} from "./types.ts";

import { assertPublicHttpUrl, isPrivateNetworkAccessAllowed } from "../core/request.ts";
import { refreshUpstreamMcpCatalog } from "./catalog.ts";
import { hashUpstreamMcpToolContract } from "./contract.ts";

const slugPattern = /^[a-z][a-z0-9-]{0,47}$/u;
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const blockedHeaderNames = new Set(["connection", "content-length", "host", "transfer-encoding"]);
const maxToolNameLength = 128;

export interface CreateMcpServerOptions {
  credential?: string;
  sync?: boolean;
}

export interface UpdateMcpServerOptions {
  credential?: string;
  sync?: boolean;
}

export interface SyncMcpServerOptions {
  connectionName?: string;
}

/**
 * Coordinates upstream MCP configuration, contract review state, and catalog
 * publication.
 */
export class UpstreamMcpServerService {
  private readonly catalog: CatalogStore;
  private readonly client: IUpstreamMcpClient;
  private readonly connections: ConnectionService;
  private readonly store: IUpstreamMcpServerStore;

  constructor(input: {
    catalog: CatalogStore;
    client: IUpstreamMcpClient;
    connections: ConnectionService;
    store: IUpstreamMcpServerStore;
  }) {
    this.catalog = input.catalog;
    this.client = input.client;
    this.connections = input.connections;
    this.store = input.store;
  }

  async initialize(): Promise<void> {
    await refreshUpstreamMcpCatalog(this.catalog, this.store);
  }

  async listServers(): Promise<UpstreamMcpServer[]> {
    return await this.store.listServers();
  }

  async getServer(service: string): Promise<UpstreamMcpServerWithTools> {
    const upstream = await this.store.getServerWithTools(service);
    if (!upstream) {
      throw new UpstreamMcpServerServiceError("mcp_server_not_found", `MCP server not found: ${service}.`, 404);
    }
    return upstream;
  }

  async createServer(
    input: CreateUpstreamMcpServerInput,
    options: CreateMcpServerOptions = {},
  ): Promise<UpstreamMcpServerWithTools> {
    const slug = normalizeSlug(input.slug);
    const now = new Date().toISOString();
    const service = `mcp_${slug.replaceAll("-", "_")}`;
    if (this.catalog.providers.some((provider) => provider.service === service)) {
      throw new UpstreamMcpServerServiceError(
        "mcp_server_conflict",
        `MCP server service conflicts with an existing provider: ${service}.`,
        409,
      );
    }
    const server: UpstreamMcpServer = {
      service,
      slug,
      displayName: normalizeRequiredText(input.displayName, "displayName", 100),
      description: normalizeOptionalText(input.description, "description", 500),
      endpoint: normalizeEndpoint(input.endpoint),
      auth: normalizeAuth(input.auth),
      enabled: true,
      revision: 1,
      syncStatus: "never",
      createdAt: now,
      updatedAt: now,
    };
    if (!(await this.store.createServer(server))) {
      throw new UpstreamMcpServerServiceError(
        "mcp_server_conflict",
        `MCP server slug or service already exists: ${slug}.`,
        409,
      );
    }
    await refreshUpstreamMcpCatalog(this.catalog, this.store);

    try {
      await this.configureDefaultCredential(server, options.credential);
    } catch (error) {
      await this.store.deleteServer(server.service);
      await refreshUpstreamMcpCatalog(this.catalog, this.store);
      throw error;
    }

    if (options.sync !== false) {
      await this.syncServer(server.service);
    }
    return await this.getServer(server.service);
  }

  async updateServer(
    service: string,
    input: UpdateUpstreamMcpServerInput,
    options: UpdateMcpServerOptions = {},
  ): Promise<UpstreamMcpServerWithTools> {
    const current = (await this.getServer(service)).server;
    const now = new Date().toISOString();
    let server: UpstreamMcpServer = {
      ...current,
      displayName:
        input.displayName === undefined
          ? current.displayName
          : normalizeRequiredText(input.displayName, "displayName", 100),
      description:
        input.description === undefined
          ? current.description
          : normalizeOptionalText(input.description, "description", 500),
      endpoint: input.endpoint === undefined ? current.endpoint : normalizeEndpoint(input.endpoint),
      auth: input.auth === undefined ? current.auth : normalizeAuth(input.auth),
      enabled: input.enabled ?? current.enabled,
      revision: current.revision + 1,
      updatedAt: now,
    };
    if (!(await this.store.updateServer(server))) {
      throw new UpstreamMcpServerServiceError("mcp_server_not_found", `MCP server not found: ${service}.`, 404);
    }
    if (server.endpoint !== current.endpoint || !sameAuth(server.auth, current.auth)) {
      const paused = await this.store.setEnabledTools({
        service,
        expectedRevision: server.revision,
        enabledTools: [],
        updatedAt: now,
      });
      if (!paused) {
        await refreshUpstreamMcpCatalog(this.catalog, this.store);
        throw new UpstreamMcpServerServiceError(
          "mcp_server_revision_conflict",
          "MCP server changed while its endpoint or authentication was being updated.",
          409,
        );
      }
      server = { ...server, revision: paused.revision };
    }
    await refreshUpstreamMcpCatalog(this.catalog, this.store);
    await this.configureDefaultCredential(server, options.credential);
    if (options.sync !== false) {
      await this.syncServer(service);
    }
    return await this.getServer(service);
  }

  async deleteServer(service: string): Promise<void> {
    if (!(await this.store.deleteServer(service))) {
      throw new UpstreamMcpServerServiceError("mcp_server_not_found", `MCP server not found: ${service}.`, 404);
    }
    await refreshUpstreamMcpCatalog(this.catalog, this.store);
  }

  async syncServer(service: string, options: SyncMcpServerOptions = {}): Promise<UpstreamMcpSyncResult> {
    const current = await this.getServer(service);
    const now = new Date().toISOString();
    try {
      const credential = await this.connections.getCredential(service, options.connectionName);
      const discovered = await this.client.discoverTools(current.server, credential);
      const sync = await buildSyncState(current, discovered, now);
      const result = await this.store.applySync(sync);
      if (!result) {
        throw new UpstreamMcpServerServiceError(
          "mcp_server_revision_conflict",
          "MCP server changed while synchronization was in progress.",
          409,
        );
      }
      await refreshUpstreamMcpCatalog(this.catalog, this.store);
      return result;
    } catch (error) {
      if (!(error instanceof UpstreamMcpServerServiceError && error.code === "mcp_server_revision_conflict")) {
        await this.store.recordSyncError(service, current.server.revision, toErrorMessage(error), now);
      }
      throw error;
    }
  }

  async setEnabledTools(service: string, input: SetUpstreamMcpToolsInput): Promise<UpstreamMcpToolSelectionResult> {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new UpstreamMcpServerServiceError("invalid_revision", "expectedRevision must be a positive integer.", 400);
    }
    const enabledTools = normalizeToolSelection(input.enabledTools);
    const result = await this.store.setEnabledTools({
      service,
      expectedRevision: input.expectedRevision,
      enabledTools,
      updatedAt: new Date().toISOString(),
    });
    if (!result) {
      throw new UpstreamMcpServerServiceError(
        "mcp_server_revision_conflict",
        "MCP server revision changed or the tool selection contains an unknown tool.",
        409,
      );
    }
    await refreshUpstreamMcpCatalog(this.catalog, this.store);
    return result;
  }

  private async configureDefaultCredential(server: UpstreamMcpServer, credential?: string): Promise<void> {
    if (server.auth.type === "none") {
      await this.connections.disconnect(server.service);
      return;
    }
    if (credential === undefined) {
      return;
    }
    await this.connections.connectWithApiKey(server.service, {
      values: { apiKey: normalizeRequiredText(credential, "credential", 16_384) },
    });
  }
}

export class UpstreamMcpServerServiceError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409;

  constructor(code: string, message: string, status: 400 | 404 | 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function buildSyncState(current: UpstreamMcpServerWithTools, discovered: DiscoveredMcpTool[], syncedAt: string) {
  const duplicates = findDuplicateToolNames(discovered);
  if (duplicates.length > 0) {
    throw new UpstreamMcpServerServiceError(
      "duplicate_tool_names",
      `MCP server returned duplicate tool names: ${duplicates.join(", ")}.`,
      400,
    );
  }

  const previousByName = new Map(current.tools.map((tool) => [tool.upstreamName, tool]));
  const usedActionNames = new Set(current.tools.map((tool) => tool.actionName));
  const tools: UpstreamMcpTool[] = [];
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  let invalid = 0;

  for (const tool of discovered) {
    const previous = previousByName.get(tool.name);
    const invalidReason = validateToolName(tool.name);
    const contractHash = await hashUpstreamMcpToolContract(tool);
    const actionName = previous?.actionName ?? createActionName(tool.name, usedActionNames);
    usedActionNames.add(actionName);
    let status: UpstreamMcpTool["status"];
    let enabled = false;
    if (invalidReason) {
      status = "invalid";
      invalid++;
    } else if (!previous) {
      status = "available";
      added++;
    } else if (previous.contractHash !== contractHash || previous.status === "removed") {
      status = "review_required";
      changed++;
    } else {
      status = previous.status;
      enabled = previous.enabled && status === "available";
      unchanged++;
    }
    tools.push({
      service: current.server.service,
      upstreamName: tool.name,
      actionName,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
      contractHash,
      enabled,
      status,
      invalidReason,
      firstSeenAt: previous?.firstSeenAt ?? syncedAt,
      lastSeenAt: syncedAt,
    });
    previousByName.delete(tool.name);
  }

  const removed = previousByName.size;
  for (const previous of previousByName.values()) {
    tools.push({
      ...previous,
      enabled: false,
      status: "removed",
    });
  }

  return {
    expectedRevision: current.server.revision,
    server: {
      ...current.server,
      revision: current.server.revision + 1,
      syncStatus: "ok" as const,
      lastSyncAt: syncedAt,
      lastSyncError: undefined,
      updatedAt: syncedAt,
    },
    tools,
    result: {
      service: current.server.service,
      discovered: discovered.length,
      added,
      changed,
      unchanged,
      removed,
      invalid,
      syncedAt,
    },
  };
}

function normalizeSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!slugPattern.test(slug)) {
    throw new UpstreamMcpServerServiceError(
      "invalid_slug",
      "slug must start with a lowercase letter and contain only lowercase letters, digits, or hyphens.",
      400,
    );
  }
  return slug;
}

function normalizeEndpoint(value: string): string {
  try {
    const url = assertPublicHttpUrl(value.trim(), {
      fieldName: "endpoint",
      allowPrivateNetwork: isPrivateNetworkAccessAllowed(),
      createError: (message) => new UpstreamMcpServerServiceError("invalid_endpoint", message, 400),
    });
    if (url.username || url.password) {
      throw new UpstreamMcpServerServiceError(
        "invalid_endpoint",
        "endpoint must not contain embedded credentials.",
        400,
      );
    }
    url.hash = "";
    return url.toString();
  } catch (error) {
    if (error instanceof UpstreamMcpServerServiceError) {
      throw error;
    }
    throw new UpstreamMcpServerServiceError("invalid_endpoint", "endpoint must be a valid HTTP URL.", 400);
  }
}

function normalizeAuth(auth: UpstreamMcpAuth): UpstreamMcpAuth {
  if (auth.type === "none" || auth.type === "bearer") {
    return { type: auth.type };
  }
  const headerName = auth.headerName.trim();
  if (!headerNamePattern.test(headerName) || blockedHeaderNames.has(headerName.toLowerCase())) {
    throw new UpstreamMcpServerServiceError("invalid_header_name", "auth.headerName is not allowed.", 400);
  }
  return { type: "api_key_header", headerName };
}

function sameAuth(left: UpstreamMcpAuth, right: UpstreamMcpAuth): boolean {
  return (
    left.type === right.type &&
    (left.type !== "api_key_header" ||
      (right.type === "api_key_header" && left.headerName.toLowerCase() === right.headerName.toLowerCase()))
  );
}

function normalizeRequiredText(value: string, fieldName: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new UpstreamMcpServerServiceError(
      "invalid_input",
      `${fieldName} must contain between 1 and ${maxLength} characters.`,
      400,
    );
  }
  return normalized;
}

function normalizeOptionalText(value: string | undefined, fieldName: string, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new UpstreamMcpServerServiceError(
      "invalid_input",
      `${fieldName} must not exceed ${maxLength} characters.`,
      400,
    );
  }
  return normalized || undefined;
}

function normalizeToolSelection(values: string[]): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) {
    throw new UpstreamMcpServerServiceError("invalid_tool_selection", "enabledTools must contain tool names.", 400);
  }
  return [...new Set(values)].sort();
}

function validateToolName(name: string): string | undefined {
  if (!name) {
    return "Tool name must not be empty.";
  }
  if (name.length > maxToolNameLength) {
    return `Tool name exceeds ${maxToolNameLength} characters.`;
  }
  return undefined;
}

function createActionName(upstreamName: string, usedNames: Set<string>): string {
  const normalized = upstreamName
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 48);
  const base = normalized && /^[a-z]/u.test(normalized) ? normalized : `tool_${stableHash(upstreamName)}`;
  if (!usedNames.has(base)) {
    return base;
  }
  return `${base.slice(0, 54)}_${stableHash(upstreamName)}`;
}

function stableHash(value: string): string {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function findDuplicateToolNames(tools: DiscoveredMcpTool[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      duplicates.add(tool.name);
    }
    seen.add(tool.name);
  }
  return [...duplicates].sort();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : "Unknown MCP synchronization error.";
}
