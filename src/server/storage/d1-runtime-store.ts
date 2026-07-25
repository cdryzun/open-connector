import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { TokenActionPolicy } from "../../core/action-policy.ts";
import type { ResolvedCredential } from "../../core/types.ts";
import type {
  ApplyUpstreamMcpSyncInput,
  IUpstreamMcpServerStore,
  SetUpstreamMcpToolsStoreInput,
} from "../../mcp-upstream/mcp-server-store.ts";
import type {
  UpstreamMcpServer,
  UpstreamMcpServerWithTools,
  UpstreamMcpSyncResult,
  UpstreamMcpTool,
  UpstreamMcpToolSelectionResult,
} from "../../mcp-upstream/types.ts";
import type { IOAuthClientConfigStore, OAuthClientConfig } from "../../oauth/oauth-client-config-service.ts";
import type { IOAuthStateStore, OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";
import type { D1DatabaseBinding } from "../cloudflare/cloudflare-bindings.ts";
import type { ISecretCodec } from "../secrets/secret-codec-core.ts";
import type {
  CompleteIdempotencyInput,
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IIdempotencyStore,
} from "./idempotency-store.ts";
import type { RuntimeDatabase } from "./runtime-database.ts";
import type { IRuntimePolicyStore, RuntimePolicyRecord } from "./runtime-policy-store.ts";
import type { IRunLogStore, RunLog, RunLogListInput, RunLogPage, RunLogWriteResult } from "./runtime-store.ts";
import type { IRuntimeTokenStore, RuntimeTokenRecord } from "./runtime-token-service.ts";

import {
  readUpstreamMcpInteger,
  readUpstreamMcpServerRow,
  readUpstreamMcpToolRow,
  upstreamMcpServerValues,
  upstreamMcpToolValues,
} from "../../mcp-upstream/storage-codec.ts";
import { parseRuntimeActionHttpResult } from "../api/runtime-api.ts";
import { PlainTextSecretCodec } from "../secrets/secret-codec-core.ts";
import { DEFAULT_RUN_LIMIT, decodeRunLogCursor, encodeRunLogCursor } from "./runtime-store.ts";

type RuntimeRow = Record<string, unknown>;
type SecretJsonTable = "oauth_client_configs";

export interface D1RuntimeDatabaseOptions {
  runLimit?: number;
  secretCodec?: ISecretCodec;
}

export class D1RuntimeDatabase implements RuntimeDatabase {
  readonly connectionStore: D1ConnectionStore;
  readonly oauthClientConfigStore: D1OAuthClientConfigStore;
  readonly oauthStateStore: D1OAuthStateStore;
  readonly runtimeTokenStore: D1RuntimeTokenStore;
  readonly runtimePolicyStore: D1RuntimePolicyStore;
  readonly runLogStore: D1RunLogStore;
  readonly idempotencyStore: D1IdempotencyStore;
  readonly upstreamMcpServerStore: D1UpstreamMcpServerStore;

  constructor(database: D1DatabaseBinding, options: D1RuntimeDatabaseOptions = {}) {
    const secretCodec = options.secretCodec ?? new PlainTextSecretCodec();
    this.connectionStore = new D1ConnectionStore(database, secretCodec);
    this.oauthClientConfigStore = new D1OAuthClientConfigStore(database, secretCodec);
    this.oauthStateStore = new D1OAuthStateStore(database);
    this.runtimeTokenStore = new D1RuntimeTokenStore(database);
    this.runtimePolicyStore = new D1RuntimePolicyStore(database);
    this.runLogStore = new D1RunLogStore(database, options.runLimit ?? DEFAULT_RUN_LIMIT);
    this.idempotencyStore = new D1IdempotencyStore(database, secretCodec);
    this.upstreamMcpServerStore = new D1UpstreamMcpServerStore(database);
  }
}

export class D1UpstreamMcpServerStore implements IUpstreamMcpServerStore {
  private readonly database: D1DatabaseBinding;

  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async getCatalogRevision(): Promise<number> {
    const row = await this.database.prepare("select revision from mcp_catalog_state where id = 1").first<RuntimeRow>();
    return readUpstreamMcpInteger(row, "revision");
  }

  async listServers(): Promise<UpstreamMcpServer[]> {
    const { results } = await this.database
      .prepare("select * from mcp_servers order by display_name, service")
      .all<RuntimeRow>();
    return results.map(readUpstreamMcpServerRow);
  }

  async getServer(service: string): Promise<UpstreamMcpServer | undefined> {
    const row = await this.database
      .prepare("select * from mcp_servers where service = ?")
      .bind(service)
      .first<RuntimeRow>();
    return row ? readUpstreamMcpServerRow(row) : undefined;
  }

  async getServerWithTools(service: string): Promise<UpstreamMcpServerWithTools | undefined> {
    const server = await this.getServer(service);
    if (!server) {
      return undefined;
    }
    return { server, tools: await this.listTools(service) };
  }

  async listEnabledServersWithTools(): Promise<UpstreamMcpServerWithTools[]> {
    const { results } = await this.database
      .prepare("select * from mcp_servers where enabled = 1 order by service")
      .all<RuntimeRow>();
    return await Promise.all(
      results.map(async (row) => {
        const server = readUpstreamMcpServerRow(row);
        const tools = await this.listTools(server.service);
        return {
          server,
          tools: tools.filter((tool) => tool.enabled && tool.status === "available"),
        };
      }),
    );
  }

  async createServer(server: UpstreamMcpServer): Promise<boolean> {
    try {
      await this.database.batch([
        this.bindServerInsert(server),
        this.database
          .prepare(
            "update mcp_catalog_state set revision = revision + 1, updated_at = ? where id = 1 and changes() > 0",
          )
          .bind(server.updatedAt),
      ]);
      return true;
    } catch (error) {
      if (isD1ConstraintError(error)) {
        return false;
      }
      throw error;
    }
  }

  async updateServer(server: UpstreamMcpServer): Promise<boolean> {
    const results = await this.database.batch([
      this.database
        .prepare(
          `
          update mcp_servers
          set display_name = ?, description = ?, endpoint = ?, auth_type = ?, header_name = ?,
              enabled = ?, revision = ?, sync_status = ?, last_sync_at = ?, last_sync_error = ?,
              updated_at = ?, mutation_token = ?
          where service = ?
        `,
        )
        .bind(
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
          server.updatedAt,
          crypto.randomUUID(),
          server.service,
        ),
      this.database
        .prepare("update mcp_catalog_state set revision = revision + 1, updated_at = ? where id = 1 and changes() > 0")
        .bind(server.updatedAt),
    ]);
    return (results[0]?.meta.changes ?? 0) > 0;
  }

  async deleteServer(service: string): Promise<boolean> {
    const results = await this.database.batch([
      this.database.prepare("delete from mcp_server_tools where service = ?").bind(service),
      this.database.prepare("delete from connections where service = ?").bind(service),
      this.database.prepare("delete from mcp_servers where service = ?").bind(service),
      this.database
        .prepare("update mcp_catalog_state set revision = revision + 1, updated_at = ? where id = 1 and changes() > 0")
        .bind(new Date().toISOString()),
    ]);
    return (results[2]?.meta.changes ?? 0) > 0;
  }

  async applySync(input: ApplyUpstreamMcpSyncInput): Promise<UpstreamMcpSyncResult | undefined> {
    const mutationToken = crypto.randomUUID();
    const statements = [
      this.bindServerSyncUpdate(input.server, input.expectedRevision, mutationToken),
      this.database
        .prepare(
          `
          delete from mcp_server_tools
          where service = ?
            and exists (select 1 from mcp_servers where service = ? and mutation_token = ?)
        `,
        )
        .bind(input.server.service, input.server.service, mutationToken),
      ...input.tools.map((tool) => this.bindConditionalToolInsert(tool, mutationToken)),
      this.database
        .prepare(
          `
          update mcp_catalog_state
          set revision = revision + 1, updated_at = ?
          where id = 1
            and exists (select 1 from mcp_servers where service = ? and mutation_token = ?)
        `,
        )
        .bind(input.result.syncedAt, input.server.service, mutationToken),
    ];
    const results = await this.database.batch(statements);
    if ((results[0]?.meta.changes ?? 0) === 0) {
      return undefined;
    }
    return { ...input.result, revision: input.server.revision };
  }

  async recordSyncError(
    service: string,
    expectedRevision: number,
    message: string,
    updatedAt: string,
  ): Promise<boolean> {
    const result = await this.database
      .prepare(
        `
        update mcp_servers
        set sync_status = 'error', last_sync_error = ?, updated_at = ?, mutation_token = ?
        where service = ? and revision = ?
      `,
      )
      .bind(message, updatedAt, crypto.randomUUID(), service, expectedRevision)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async setEnabledTools(input: SetUpstreamMcpToolsStoreInput): Promise<UpstreamMcpToolSelectionResult | undefined> {
    const server = await this.getServer(input.service);
    if (!server || server.revision !== input.expectedRevision) {
      return undefined;
    }
    const tools = await this.listTools(input.service);
    const available = new Set(tools.filter((tool) => tool.status !== "removed").map((tool) => tool.upstreamName));
    if (input.enabledTools.some((toolName) => !available.has(toolName))) {
      return undefined;
    }

    const nextRevision = input.expectedRevision + 1;
    const mutationToken = crypto.randomUUID();
    const statements = [
      this.database
        .prepare(
          `
          update mcp_servers
          set revision = ?, updated_at = ?, mutation_token = ?
          where service = ? and revision = ?
        `,
        )
        .bind(nextRevision, input.updatedAt, mutationToken, input.service, input.expectedRevision),
      this.database
        .prepare(
          `
          update mcp_server_tools
          set enabled = 0
          where service = ?
            and exists (
              select 1 from mcp_servers where service = ? and mutation_token = ?
            )
        `,
        )
        .bind(input.service, input.service, mutationToken),
      ...input.enabledTools.map((toolName) =>
        this.database
          .prepare(
            `
            update mcp_server_tools
            set enabled = 1, status = 'available'
            where service = ? and upstream_name = ?
              and exists (
                select 1 from mcp_servers where service = ? and mutation_token = ?
              )
          `,
          )
          .bind(input.service, toolName, input.service, mutationToken),
      ),
      this.database
        .prepare(
          `
          update mcp_catalog_state
          set revision = revision + 1, updated_at = ?
          where id = 1 and exists (
            select 1 from mcp_servers where service = ? and mutation_token = ?
          )
        `,
        )
        .bind(input.updatedAt, input.service, mutationToken),
    ];
    const results = await this.database.batch(statements);
    if ((results[0]?.meta.changes ?? 0) === 0) {
      return undefined;
    }
    return {
      service: input.service,
      revision: nextRevision,
      enabledTools: [...input.enabledTools].sort(),
    };
  }

  private async listTools(service: string): Promise<UpstreamMcpTool[]> {
    const { results } = await this.database
      .prepare("select * from mcp_server_tools where service = ? order by upstream_name")
      .bind(service)
      .all<RuntimeRow>();
    return results.map(readUpstreamMcpToolRow);
  }

  private bindServerInsert(server: UpstreamMcpServer) {
    return this.database
      .prepare(
        `
        insert into mcp_servers (
          service, slug, display_name, description, endpoint, auth_type, header_name, enabled, revision,
          sync_status, last_sync_at, last_sync_error, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(...upstreamMcpServerValues(server));
  }

  private bindServerSyncUpdate(server: UpstreamMcpServer, expectedRevision: number, mutationToken: string) {
    return this.database
      .prepare(
        `
        update mcp_servers
        set display_name = ?, description = ?, endpoint = ?, auth_type = ?, header_name = ?,
            enabled = ?, revision = ?, sync_status = ?, last_sync_at = ?, last_sync_error = ?,
            updated_at = ?, mutation_token = ?
        where service = ? and revision = ?
      `,
      )
      .bind(
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
        server.updatedAt,
        mutationToken,
        server.service,
        expectedRevision,
      );
  }

  private bindConditionalToolInsert(tool: UpstreamMcpTool, mutationToken: string) {
    return this.database
      .prepare(
        `
        insert into mcp_server_tools (
          service, upstream_name, action_name, title, description, input_schema, output_schema, annotations,
          contract_hash, enabled, status, invalid_reason, first_seen_at, last_seen_at
        )
        select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        where exists (select 1 from mcp_servers where service = ? and mutation_token = ?)
      `,
      )
      .bind(...upstreamMcpToolValues(tool), tool.service, mutationToken);
  }
}

export class D1ConnectionStore implements IConnectionStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    const row = await this.database
      .prepare("select id, value from connections where service = ? and connection_name = ?")
      .bind(service, connectionName)
      .first<RuntimeRow>();
    return row
      ? {
          id: readString(row, "id"),
          service,
          connectionName,
          credential: parseJson<ResolvedCredential>(await this.secretCodec.decode(readString(row, "value"))),
        }
      : undefined;
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredConnection> {
    const row = await this.database
      .prepare(
        `
        insert into connections (id, service, connection_name, value, updated_at)
        values (?, ?, ?, ?, ?)
        on conflict(service, connection_name) do update set
          value = excluded.value,
          updated_at = excluded.updated_at
        returning id
      `,
      )
      .bind(
        crypto.randomUUID(),
        service,
        connectionName,
        await this.secretCodec.encode(JSON.stringify(credential)),
        new Date().toISOString(),
      )
      .first<RuntimeRow>();
    return { id: readString(row!, "id"), service, connectionName, credential };
  }

  async updateCredential(input: StoredConnection): Promise<boolean> {
    const row = await this.database
      .prepare(
        `
        update connections
        set value = ?, updated_at = ?
        where service = ? and connection_name = ? and id = ?
        returning id
      `,
      )
      .bind(
        await this.secretCodec.encode(JSON.stringify(input.credential)),
        new Date().toISOString(),
        input.service,
        input.connectionName,
        input.id,
      )
      .first<RuntimeRow>();
    return row !== null;
  }

  async delete(service: string, connectionName: string): Promise<void> {
    await this.database
      .prepare("delete from connections where service = ? and connection_name = ?")
      .bind(service, connectionName)
      .run();
  }

  async list(): Promise<StoredConnection[]> {
    const { results } = await this.database
      .prepare("select id, service, connection_name, value from connections order by service, connection_name")
      .all<RuntimeRow>();
    return await Promise.all(
      results.map(async (row) => ({
        id: readString(row, "id"),
        service: readString(row, "service"),
        connectionName: readString(row, "connection_name"),
        credential: parseJson<ResolvedCredential>(await this.secretCodec.decode(readString(row, "value"))),
      })),
    );
  }
}

export class D1OAuthClientConfigStore implements IOAuthClientConfigStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async get(service: string): Promise<OAuthClientConfig | undefined> {
    return await getSecretJson<OAuthClientConfig>(this.database, this.secretCodec, "oauth_client_configs", service);
  }

  async set(config: OAuthClientConfig): Promise<void> {
    await this.database
      .prepare(
        `
        insert into oauth_client_configs (service, value, updated_at)
        values (?, ?, ?)
        on conflict(service) do update set value = excluded.value, updated_at = excluded.updated_at
      `,
      )
      .bind(config.service, await this.secretCodec.encode(JSON.stringify(config)), new Date().toISOString())
      .run();
  }

  async delete(service: string): Promise<void> {
    await this.database.prepare("delete from oauth_client_configs where service = ?").bind(service).run();
  }

  async list(): Promise<OAuthClientConfig[]> {
    const { results } = await this.database
      .prepare("select value from oauth_client_configs order by service")
      .all<RuntimeRow>();
    return await Promise.all(
      results.map(async (row) => parseJson<OAuthClientConfig>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }
}

export class D1OAuthStateStore implements IOAuthStateStore {
  private readonly database: D1DatabaseBinding;

  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async set(state: OAuthAuthorizationState): Promise<void> {
    await this.database
      .prepare(
        `
        insert into oauth_states (state, value, created_at)
        values (?, ?, ?)
        on conflict(state) do update set value = excluded.value, created_at = excluded.created_at
      `,
      )
      .bind(state.state, JSON.stringify(state), state.createdAt)
      .run();
  }

  async take(state: string): Promise<OAuthAuthorizationState | undefined> {
    const row = await this.database
      .prepare("delete from oauth_states where state = ? returning value")
      .bind(state)
      .first<RuntimeRow>();
    return row ? parseJson<OAuthAuthorizationState>(readString(row, "value")) : undefined;
  }
}

export class D1RuntimeTokenStore implements IRuntimeTokenStore {
  private readonly database: D1DatabaseBinding;

  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async add(record: RuntimeTokenRecord): Promise<void> {
    await this.database
      .prepare(
        `
        insert into runtime_tokens (
          id, name, token_hash, allowed_actions, blocked_actions, created_at, last_used_at
        )
        values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        record.id,
        record.name,
        record.tokenHash,
        JSON.stringify(record.allowedActions),
        JSON.stringify(record.blockedActions),
        record.createdAt,
        record.lastUsedAt ?? null,
      )
      .run();
  }

  async list(): Promise<RuntimeTokenRecord[]> {
    const { results } = await this.database
      .prepare(
        `
        select id, name, token_hash, allowed_actions, blocked_actions, created_at, last_used_at
        from runtime_tokens
        where revoked_at is null
        order by created_at desc, id desc
      `,
      )
      .all<RuntimeRow>();
    return results.map(readRuntimeTokenRow);
  }

  async findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined> {
    const row = await this.database
      .prepare(
        `
        select id, name, token_hash, allowed_actions, blocked_actions, created_at, last_used_at
        from runtime_tokens
        where token_hash = ? and revoked_at is null
      `,
      )
      .bind(tokenHash)
      .first<RuntimeRow>();
    return row ? readRuntimeTokenRow(row) : undefined;
  }

  async updatePolicy(id: string, policy: TokenActionPolicy): Promise<RuntimeTokenRecord | undefined> {
    const row = await this.database
      .prepare(
        `
        update runtime_tokens
        set allowed_actions = ?, blocked_actions = ?
        where id = ? and revoked_at is null
        returning id, name, token_hash, allowed_actions, blocked_actions, created_at, last_used_at
      `,
      )
      .bind(JSON.stringify(policy.allowedActions), JSON.stringify(policy.blockedActions), id)
      .first<RuntimeRow>();
    return row ? readRuntimeTokenRow(row) : undefined;
  }

  async revoke(id: string): Promise<boolean> {
    const result = await this.database.prepare("delete from runtime_tokens where id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async markUsed(id: string, usedAt: string): Promise<void> {
    await this.database
      .prepare("update runtime_tokens set last_used_at = ? where id = ? and revoked_at is null")
      .bind(usedAt, id)
      .run();
  }
}

function readRuntimeTokenRow(row: RuntimeRow): RuntimeTokenRecord {
  return {
    id: readString(row, "id"),
    name: readString(row, "name"),
    tokenHash: readString(row, "token_hash"),
    allowedActions: parseJson(readString(row, "allowed_actions")),
    blockedActions: parseJson(readString(row, "blocked_actions")),
    createdAt: readString(row, "created_at"),
    lastUsedAt: readOptionalString(row, "last_used_at"),
  };
}

export class D1RuntimePolicyStore implements IRuntimePolicyStore {
  private readonly database: D1DatabaseBinding;

  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async get(): Promise<RuntimePolicyRecord | undefined> {
    const row = await this.database
      .prepare("select value, updated_at from runtime_policy where id = 1")
      .first<RuntimeRow>();
    return row
      ? {
          rules: parseJson(readString(row, "value")),
          updatedAt: readString(row, "updated_at"),
        }
      : undefined;
  }

  async set(record: RuntimePolicyRecord): Promise<void> {
    await this.database
      .prepare(
        `
        insert into runtime_policy (id, value, updated_at)
        values (1, ?, ?)
        on conflict(id) do update set value = excluded.value, updated_at = excluded.updated_at
      `,
      )
      .bind(JSON.stringify(record.rules), record.updatedAt)
      .run();
  }
}

export class D1IdempotencyStore implements IIdempotencyStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    await this.database.prepare("delete from idempotency_records where expires_at <= ?").bind(input.now).run();

    const inserted = await this.database
      .prepare(
        `
        insert into idempotency_records (
          key_hash, claim_id, request_hash, state, response_value, created_at, expires_at
        )
        values (?, ?, ?, 'in_progress', null, ?, ?)
        on conflict(key_hash) do nothing
      `,
      )
      .bind(input.keyHash, input.claimId, input.requestHash, input.now, input.expiresAt)
      .run();
    if ((inserted.meta.changes ?? 0) > 0) {
      return { kind: "acquired" };
    }

    const row = await this.database
      .prepare("select request_hash, state, response_value from idempotency_records where key_hash = ?")
      .bind(input.keyHash)
      .first<RuntimeRow>();
    if (!row) {
      throw new Error("Idempotency record disappeared while claiming it.");
    }
    if (readString(row, "request_hash") !== input.requestHash) {
      return { kind: "conflict" };
    }
    if (readString(row, "state") === "in_progress") {
      return { kind: "in_progress" };
    }

    const response = parseRuntimeActionHttpResult(
      parseJson(await this.secretCodec.decode(readString(row, "response_value"))),
    );
    return { kind: "completed", response };
  }

  async complete(input: CompleteIdempotencyInput): Promise<boolean> {
    const result = await this.database
      .prepare(
        `
        update idempotency_records
        set state = 'completed', response_value = ?, expires_at = ?
        where key_hash = ?
          and claim_id = ?
          and request_hash = ?
          and state = 'in_progress'
      `,
      )
      .bind(
        await this.secretCodec.encode(JSON.stringify(input.response)),
        input.expiresAt,
        input.keyHash,
        input.claimId,
        input.requestHash,
      )
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

export class D1RunLogStore implements IRunLogStore {
  private readonly database: D1DatabaseBinding;
  private readonly limit: number;

  constructor(database: D1DatabaseBinding, limit: number) {
    this.database = database;
    this.limit = limit;
  }

  async add(run: RunLog): Promise<RunLogWriteResult> {
    await this.database
      .prepare(
        `
        insert into runs (id, service, action_id, caller, started_at, completed_at, ok, value)
        values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          service = excluded.service,
          action_id = excluded.action_id,
          caller = excluded.caller,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          ok = excluded.ok,
          value = excluded.value
      `,
      )
      .bind(
        run.id,
        run.service,
        run.actionId,
        run.caller,
        run.startedAt,
        run.completedAt,
        run.ok ? 1 : 0,
        JSON.stringify(run),
      )
      .run();

    try {
      await this.database
        .prepare(
          `
          delete from runs
          where id in (
            select id from runs
            order by started_at desc, id desc
            limit -1 offset ?
          )
        `,
        )
        .bind(this.limit)
        .run();
      return { retentionApplied: true };
    } catch {
      return { retentionApplied: false };
    }
  }

  async get(id: string): Promise<RunLog | undefined> {
    const row = await this.database
      .prepare("select service, value from runs where id = ?")
      .bind(id)
      .first<RuntimeRow>();
    return row ? readRunLogRow(row) : undefined;
  }

  async list(input: RunLogListInput = {}): Promise<RunLogPage> {
    const limit = Math.max(1, Math.min(input.limit ?? this.limit, this.limit));
    const cursor = decodeRunLogCursor(input.cursor);
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (cursor) {
      conditions.push("(started_at < ? or (started_at = ? and id < ?))");
      values.push(cursor.startedAt, cursor.startedAt, cursor.id);
    }
    if (input.service) {
      conditions.push("service = ?");
      values.push(input.service);
    }
    if (input.actionId) {
      conditions.push("action_id = ?");
      values.push(input.actionId);
    }
    if (input.caller) {
      conditions.push("caller = ?");
      values.push(input.caller);
    }
    if (input.ok !== undefined) {
      conditions.push("ok = ?");
      values.push(input.ok ? 1 : 0);
    }
    const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const { results } = await this.database
      .prepare(`select service, value from runs ${where} order by started_at desc, id desc limit ?`)
      .bind(...values, limit + 1)
      .all<RuntimeRow>();
    const runs = results.map(readRunLogRow);
    const items = runs.slice(0, limit);

    return {
      items,
      nextCursor: runs.length > limit && items.length > 0 ? encodeRunLogCursor(items[items.length - 1]) : undefined,
    };
  }
}

async function getSecretJson<T>(
  database: D1DatabaseBinding,
  secretCodec: ISecretCodec,
  table: SecretJsonTable,
  service: string,
): Promise<T | undefined> {
  const row = await database.prepare(`select value from ${table} where service = ?`).bind(service).first<RuntimeRow>();
  return row ? parseJson<T>(await secretCodec.decode(readString(row, "value"))) : undefined;
}

function readString(row: RuntimeRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected D1 column ${key} to be a string.`);
  }

  return value;
}

function readRunLogRow(row: RuntimeRow): RunLog {
  const run = parseJson<RunLog>(readString(row, "value"));
  return { ...run, service: readString(row, "service") };
}

function readOptionalString(row: RuntimeRow, key: string): string | undefined {
  const value = row[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected D1 column ${key} to be a string.`);
  }

  return value;
}

function isD1ConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/i.test(error.message);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
