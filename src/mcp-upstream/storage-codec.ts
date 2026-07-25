import type { JsonSchema } from "../core/types.ts";
import type { UpstreamMcpAuth, UpstreamMcpServer, UpstreamMcpTool } from "./types.ts";

type SqlValue = string | number | null;

export function readUpstreamMcpInteger(row: unknown, key: string): number {
  const value = readRow(row)[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Expected upstream MCP storage column ${key} to be an integer.`);
  }
  return value;
}

export function readUpstreamMcpServerRow(row: unknown): UpstreamMcpServer {
  const syncStatus = readString(row, "sync_status");
  if (syncStatus !== "never" && syncStatus !== "ok" && syncStatus !== "error") {
    throw new Error(`Unexpected upstream MCP sync status: ${syncStatus}.`);
  }
  return {
    service: readString(row, "service"),
    slug: readString(row, "slug"),
    displayName: readString(row, "display_name"),
    description: readOptionalString(row, "description"),
    endpoint: readString(row, "endpoint"),
    auth: readAuth(row),
    enabled: readBoolean(row, "enabled"),
    revision: readUpstreamMcpInteger(row, "revision"),
    syncStatus,
    lastSyncAt: readOptionalString(row, "last_sync_at"),
    lastSyncError: readOptionalString(row, "last_sync_error"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

export function readUpstreamMcpToolRow(row: unknown): UpstreamMcpTool {
  const status = readString(row, "status");
  if (status !== "available" && status !== "review_required" && status !== "removed" && status !== "invalid") {
    throw new Error(`Unexpected upstream MCP tool status: ${status}.`);
  }
  const outputSchema = readOptionalString(row, "output_schema");
  const annotations = readOptionalString(row, "annotations");
  return {
    service: readString(row, "service"),
    upstreamName: readString(row, "upstream_name"),
    actionName: readString(row, "action_name"),
    title: readOptionalString(row, "title"),
    description: readOptionalString(row, "description"),
    inputSchema: parseJsonObject(readString(row, "input_schema")),
    outputSchema: outputSchema ? parseJsonObject(outputSchema) : undefined,
    annotations: annotations ? parseJsonObject(annotations) : undefined,
    contractHash: readString(row, "contract_hash"),
    enabled: readBoolean(row, "enabled"),
    status,
    invalidReason: readOptionalString(row, "invalid_reason"),
    firstSeenAt: readString(row, "first_seen_at"),
    lastSeenAt: readString(row, "last_seen_at"),
  };
}

export function upstreamMcpServerValues(server: UpstreamMcpServer): SqlValue[] {
  return [
    server.service,
    server.slug,
    server.displayName,
    server.description ?? null,
    server.endpoint,
    server.auth.type,
    server.auth.type === "api_key_header" ? server.auth.headerName : null,
    server.enabled ? 1 : 0,
    server.revision,
    server.syncStatus,
    server.lastSyncAt ?? null,
    server.lastSyncError ?? null,
    server.createdAt,
    server.updatedAt,
  ];
}

export function upstreamMcpToolValues(tool: UpstreamMcpTool): SqlValue[] {
  return [
    tool.service,
    tool.upstreamName,
    tool.actionName,
    tool.title ?? null,
    tool.description ?? null,
    JSON.stringify(tool.inputSchema),
    tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
    tool.annotations ? JSON.stringify(tool.annotations) : null,
    tool.contractHash,
    tool.enabled ? 1 : 0,
    tool.status,
    tool.invalidReason ?? null,
    tool.firstSeenAt,
    tool.lastSeenAt,
  ];
}

function readAuth(row: unknown): UpstreamMcpAuth {
  const type = readString(row, "auth_type");
  if (type === "none" || type === "bearer") {
    return { type };
  }
  if (type === "api_key_header") {
    const headerName = readOptionalString(row, "header_name");
    if (!headerName) {
      throw new Error("Expected upstream MCP storage column header_name for api_key_header.");
    }
    return { type, headerName };
  }
  throw new Error(`Unexpected upstream MCP auth type: ${type}.`);
}

function readBoolean(row: unknown, key: string): boolean {
  const value = readUpstreamMcpInteger(row, key);
  if (value !== 0 && value !== 1) {
    throw new Error(`Expected upstream MCP storage column ${key} to be a boolean integer.`);
  }
  return value === 1;
}

function readString(row: unknown, key: string): string {
  const value = readRow(row)[key];
  if (typeof value !== "string") {
    throw new Error(`Expected upstream MCP storage column ${key} to be a string.`);
  }
  return value;
}

function readOptionalString(row: unknown, key: string): string | undefined {
  const value = readRow(row)[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected upstream MCP storage column ${key} to be a string.`);
  }
  return value;
}

function readRow(row: unknown): Record<string, unknown> {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("Expected an upstream MCP storage row.");
  }
  return row as Record<string, unknown>;
}

function parseJsonObject(value: string): JsonSchema {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected an upstream MCP storage JSON object.");
  }
  return parsed as JsonSchema;
}
