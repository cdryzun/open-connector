import type { JsonSchema } from "../core/types.ts";

export type UpstreamMcpAuth = { type: "none" } | { type: "bearer" } | { type: "api_key_header"; headerName: string };

export type UpstreamMcpSyncStatus = "never" | "ok" | "error";

export interface UpstreamMcpServer {
  service: string;
  slug: string;
  displayName: string;
  description?: string;
  endpoint: string;
  auth: UpstreamMcpAuth;
  enabled: boolean;
  revision: number;
  syncStatus: UpstreamMcpSyncStatus;
  lastSyncAt?: string;
  lastSyncError?: string;
  createdAt: string;
  updatedAt: string;
}

export type UpstreamMcpToolStatus = "available" | "review_required" | "removed" | "invalid";

export interface UpstreamMcpTool {
  service: string;
  upstreamName: string;
  actionName: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
  contractHash: string;
  enabled: boolean;
  status: UpstreamMcpToolStatus;
  invalidReason?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface UpstreamMcpServerWithTools {
  server: UpstreamMcpServer;
  tools: UpstreamMcpTool[];
}

export interface DiscoveredMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
}

export interface UpstreamMcpSyncResult {
  service: string;
  revision: number;
  discovered: number;
  added: number;
  changed: number;
  unchanged: number;
  removed: number;
  invalid: number;
  syncedAt: string;
}

export interface UpstreamMcpToolSelectionResult {
  service: string;
  revision: number;
  enabledTools: string[];
}

export interface CreateUpstreamMcpServerInput {
  slug: string;
  displayName: string;
  description?: string;
  endpoint: string;
  auth: UpstreamMcpAuth;
}

export interface UpdateUpstreamMcpServerInput {
  displayName?: string;
  description?: string;
  endpoint?: string;
  auth?: UpstreamMcpAuth;
  enabled?: boolean;
}

export interface SetUpstreamMcpToolsInput {
  expectedRevision: number;
  enabledTools: string[];
}
