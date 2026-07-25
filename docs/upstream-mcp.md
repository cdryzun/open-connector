# Upstream MCP Servers

OpenConnector can register remote MCP servers as runtime providers. Discovered MCP tools become
OpenConnector Actions, so downstream clients keep using the stable discovery tools exposed by
`POST /mcp` instead of importing every upstream tool into their own MCP session.

## Supported Contract

The first version supports:

- MCP Streamable HTTP endpoints
- no authentication
- bearer tokens
- one custom API key header
- Node with SQLite and Cloudflare Workers with D1
- named OpenConnector connections for the same MCP server

OAuth discovery, DCR, CIMD, legacy SSE transports, and stdio upstreams are not supported.

Every server receives a stable service id in the form `mcp_<slug>`. The upstream tool name is
preserved for MCP calls, while OpenConnector assigns a route-safe Action name. The Web Console and
admin API never return stored credential values.

## Register A Server

Create and synchronize a public unauthenticated server:

```bash
curl -s -X POST http://localhost:3000/api/mcp-servers \
  -H 'content-type: application/json' \
  -d '{
    "slug": "example",
    "displayName": "Example MCP",
    "endpoint": "https://mcp.example.com/mcp",
    "auth": {"type": "none"},
    "sync": true
  }'
```

For bearer authentication, use:

```json
{
  "auth": { "type": "bearer" },
  "credential": "<token>"
}
```

For a custom API key header, use:

```json
{
  "auth": {
    "type": "api_key_header",
    "headerName": "X-API-Key"
  },
  "credential": "<api-key>"
}
```

The credential is stored as the server's `default` OpenConnector connection. Additional named
connections use the existing connection endpoint:

```bash
curl -s -X PUT http://localhost:3000/api/connections/mcp_example \
  -H 'content-type: application/json' \
  -d '{
    "authType": "api_key",
    "connectionName": "secondary",
    "values": {"apiKey": "<token>"}
  }'
```

All named connections for one server must expose the same tool contract. Synchronization may use a
named connection by passing `connectionName`; the resulting contract applies to the server, not
only to that connection.

## Review And Publish Tools

New tools are discovered as disabled. If an enabled tool changes its title, description, input
schema, output schema, or annotations, OpenConnector changes its status to `review_required` and
disables it. Tools removed by the upstream server remain recorded as `removed` and are not
executable.

List the current contract and server revision:

```bash
curl -s http://localhost:3000/api/mcp-servers/mcp_example/tools
```

Publish an explicit reviewed set:

```bash
curl -s -X PUT http://localhost:3000/api/mcp-servers/mcp_example/tools \
  -H 'content-type: application/json' \
  -d '{
    "expectedRevision": 2,
    "enabledTools": ["search", "get_record"]
  }'
```

`expectedRevision` provides optimistic locking. A stale revision returns `409` and does not replace
the current selection.

Synchronize manually:

```bash
curl -s -X POST http://localhost:3000/api/mcp-servers/mcp_example/sync \
  -H 'content-type: application/json' \
  -d '{}'
```

There is no periodic synchronization. Create and update operations synchronize by default, and the
Web Console provides an explicit Sync action.

## Downstream Agent Usage

Enabled tools appear in the normal provider and Action catalog. A downstream MCP client still sees
the stable OpenConnector tools:

- `list_apps`
- `list_connections`
- `search_actions`
- `get_action_guide`
- `execute_action`

For example, search for the dynamically published Action, read its guide, then execute it with
`execute_action`. OpenConnector selects the named connection, applies policy and input validation,
calls the original upstream MCP tool, and writes the normal run audit record.

## Limits And Security

Synchronization enforces these limits:

- 20 `tools/list` pages
- 500 tools
- 256 KiB per tool contract
- 5 MiB total tool contract data
- 120 seconds per synchronization request

All upstream requests use the shared SSRF-guarded provider fetch. URL literals, DNS answers, and
redirect targets are validated. Credentials are removed when a redirect crosses origins, including
runtime-configured custom API key headers.

Private-network endpoints are disabled by default. Self-hosted deployments may opt in with
`OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK=true`; loopback, link-local, reserved, and cloud metadata
targets remain blocked.

## Admin API

| Method   | Path                              | Purpose                                  |
| -------- | --------------------------------- | ---------------------------------------- |
| `GET`    | `/api/mcp-servers`                | List configured servers                  |
| `POST`   | `/api/mcp-servers`                | Create and optionally synchronize        |
| `GET`    | `/api/mcp-servers/:service`       | Read one server and its tools            |
| `PUT`    | `/api/mcp-servers/:service`       | Update and optionally synchronize        |
| `DELETE` | `/api/mcp-servers/:service`       | Delete the server and stored connections |
| `GET`    | `/api/mcp-servers/:service/tools` | Read tool contracts and current revision |
| `PUT`    | `/api/mcp-servers/:service/tools` | Publish the reviewed tool selection      |
| `POST`   | `/api/mcp-servers/:service/sync`  | Synchronize tool contracts               |

These endpoints use the same admin authentication as the rest of `/api/*`.
