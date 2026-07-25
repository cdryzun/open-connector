import type {
  UpstreamMcpServer,
  UpstreamMcpServerWithTools,
  UpstreamMcpSyncResult,
  UpstreamMcpTool,
  UpstreamMcpToolSelectionResult,
} from "./types.ts";

export interface ApplyUpstreamMcpSyncInput {
  expectedRevision: number;
  server: UpstreamMcpServer;
  tools: UpstreamMcpTool[];
  result: Omit<UpstreamMcpSyncResult, "revision">;
}

export interface SetUpstreamMcpToolsStoreInput {
  service: string;
  expectedRevision: number;
  enabledTools: string[];
  updatedAt: string;
}

export interface IUpstreamMcpServerStore {
  getCatalogRevision(): Promise<number>;
  listServers(): Promise<UpstreamMcpServer[]>;
  getServer(service: string): Promise<UpstreamMcpServer | undefined>;
  getServerWithTools(service: string): Promise<UpstreamMcpServerWithTools | undefined>;
  listEnabledServersWithTools(): Promise<UpstreamMcpServerWithTools[]>;
  createServer(server: UpstreamMcpServer): Promise<boolean>;
  updateServer(server: UpstreamMcpServer): Promise<boolean>;
  deleteServer(service: string): Promise<boolean>;
  applySync(input: ApplyUpstreamMcpSyncInput): Promise<UpstreamMcpSyncResult | undefined>;
  recordSyncError(service: string, expectedRevision: number, message: string, updatedAt: string): Promise<boolean>;
  setEnabledTools(input: SetUpstreamMcpToolsStoreInput): Promise<UpstreamMcpToolSelectionResult | undefined>;
}
