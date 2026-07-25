create table mcp_servers (
  service text primary key,
  slug text not null unique,
  display_name text not null,
  description text,
  endpoint text not null,
  auth_type text not null,
  header_name text,
  enabled integer not null,
  revision integer not null,
  sync_status text not null,
  last_sync_at text,
  last_sync_error text,
  mutation_token text not null default '',
  created_at text not null,
  updated_at text not null
);

create table mcp_server_tools (
  service text not null,
  upstream_name text not null,
  action_name text not null,
  title text,
  description text,
  input_schema text not null,
  output_schema text,
  annotations text,
  contract_hash text not null,
  enabled integer not null,
  status text not null,
  invalid_reason text,
  first_seen_at text not null,
  last_seen_at text not null,
  primary key (service, upstream_name),
  unique (service, action_name),
  foreign key (service) references mcp_servers(service) on delete cascade
);

create table mcp_catalog_state (
  id integer primary key check (id = 1),
  revision integer not null,
  updated_at text not null
);

insert into mcp_catalog_state (id, revision, updated_at)
values (1, 0, '1970-01-01T00:00:00.000Z');
