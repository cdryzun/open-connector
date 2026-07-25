import type { UpstreamMcpAuth, UpstreamMcpServer, UpstreamMcpServerWithTools } from "./model";
import type { FormEvent, ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { Check, Loader2, Plus, RefreshCw, Save, Server, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { Badge, EmptyState, FormStatus, InlineError } from "./shared-ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface McpServersPageProps {
  onRefresh(): void;
}

type AuthType = UpstreamMcpAuth["type"];

export function McpServersPage(props: McpServersPageProps): ReactNode {
  const t = useTranslate();
  const [servers, setServers] = useState<UpstreamMcpServer[]>([]);
  const [selectedService, setSelectedService] = useState("");
  const [detail, setDetail] = useState<UpstreamMcpServerWithTools | null>(null);
  const [enabledTools, setEnabledTools] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [headerName, setHeaderName] = useState("X-API-Key");
  const [credential, setCredential] = useState("");

  const currentServer = servers.find((server) => server.service === selectedService);
  const reviewCount = useMemo(
    () => detail?.tools.filter((tool) => tool.status === "review_required").length ?? 0,
    [detail],
  );

  useEffect(() => {
    let cancelled = false;
    void apiGet<UpstreamMcpServer[]>("/api/mcp-servers")
      .then((value) => {
        if (!cancelled) {
          setServers(value);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(errorMessage(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (servers.length === 0) {
      setSelectedService("");
      setDetail(null);
      return;
    }
    if (!servers.some((server) => server.service === selectedService)) {
      setSelectedService(servers[0]!.service);
    }
  }, [servers, selectedService]);

  useEffect(() => {
    if (!selectedService) {
      return;
    }
    let cancelled = false;
    void apiGet<UpstreamMcpServerWithTools>(`/api/mcp-servers/${encodeURIComponent(selectedService)}`)
      .then((value) => {
        if (!cancelled) {
          setDetail(value);
          setEnabledTools(value.tools.filter((tool) => tool.enabled).map((tool) => tool.upstreamName));
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(errorMessage(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedService, servers]);

  async function createServer(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(t("mcpServers.creating"));
    try {
      const auth: UpstreamMcpAuth = authType === "api_key_header" ? { type: authType, headerName } : { type: authType };
      const created = await apiPost<UpstreamMcpServerWithTools>("/api/mcp-servers", {
        slug,
        displayName,
        endpoint,
        auth,
        credential: authType === "none" ? undefined : credential,
        sync: true,
      });
      setSelectedService(created.server.service);
      setCreating(false);
      setSlug("");
      setDisplayName("");
      setEndpoint("");
      setCredential("");
      setStatus(t("mcpServers.created"));
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus(null);
    } finally {
      await refreshAfterMutation();
      setBusy(false);
    }
  }

  async function syncServer(): Promise<void> {
    if (!detail) return;
    setBusy(true);
    setError(null);
    setStatus(t("mcpServers.syncing"));
    try {
      await apiPost(`/api/mcp-servers/${encodeURIComponent(detail.server.service)}/sync`, {});
      setStatus(t("mcpServers.synced"));
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus(null);
    } finally {
      await refreshAfterMutation();
      setBusy(false);
    }
  }

  async function saveTools(): Promise<void> {
    if (!detail) return;
    setBusy(true);
    setError(null);
    setStatus(t("mcpServers.savingTools"));
    try {
      await apiPut(`/api/mcp-servers/${encodeURIComponent(detail.server.service)}/tools`, {
        expectedRevision: detail.server.revision,
        enabledTools,
      });
      setStatus(t("mcpServers.toolsSaved"));
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus(null);
    } finally {
      await refreshAfterMutation();
      setBusy(false);
    }
  }

  async function toggleServer(): Promise<void> {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      await apiPut(`/api/mcp-servers/${encodeURIComponent(detail.server.service)}`, {
        enabled: !detail.server.enabled,
        sync: false,
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      await refreshAfterMutation();
      setBusy(false);
    }
  }

  async function deleteServer(): Promise<void> {
    if (!detail || !window.confirm(t("mcpServers.deleteConfirm", { name: detail.server.displayName }))) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`/api/mcp-servers/${encodeURIComponent(detail.server.service)}`);
      setSelectedService("");
      setDetail(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      await refreshAfterMutation();
      setBusy(false);
    }
  }

  async function refreshAfterMutation(): Promise<void> {
    await reloadServers(setServers).catch(() => undefined);
    props.onRefresh();
  }

  function toggleTool(name: string): void {
    setEnabledTools((current) =>
      current.includes(name) ? current.filter((candidate) => candidate !== name) : [...current, name],
    );
  }

  return (
    <section className="mcp-servers-page">
      <div className="mcp-servers-toolbar">
        <div>
          <h2>{t("mcpServers.title")}</h2>
          <p>{t("mcpServers.description")}</p>
        </div>
        <Button onClick={() => setCreating((value) => !value)}>
          <Plus size={15} />
          {t("mcpServers.add")}
        </Button>
      </div>

      {error ? <InlineError message={error} /> : null}
      {status ? <FormStatus message={status} /> : null}

      {creating ? (
        <Card className="mcp-create-card">
          <form className="mcp-create-grid" onSubmit={createServer}>
            <Label className="field">
              <span>{t("mcpServers.fields.name")}</span>
              <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
            </Label>
            <Label className="field">
              <span>{t("mcpServers.fields.slug")}</span>
              <Input
                value={slug}
                onChange={(event) => setSlug(event.target.value.toLowerCase())}
                pattern="[a-z][a-z0-9-]*"
                required
              />
            </Label>
            <Label className="field mcp-wide-field">
              <span>{t("mcpServers.fields.endpoint")}</span>
              <Input
                type="url"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="https://mcp.example.com/mcp"
                required
              />
            </Label>
            <Label className="field">
              <span>{t("mcpServers.fields.auth")}</span>
              <Select value={authType} onValueChange={(value) => setAuthType(value as AuthType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("mcpServers.auth.none")}</SelectItem>
                  <SelectItem value="bearer">{t("mcpServers.auth.bearer")}</SelectItem>
                  <SelectItem value="api_key_header">{t("mcpServers.auth.apiKeyHeader")}</SelectItem>
                </SelectContent>
              </Select>
            </Label>
            {authType === "api_key_header" ? (
              <Label className="field">
                <span>{t("mcpServers.fields.headerName")}</span>
                <Input value={headerName} onChange={(event) => setHeaderName(event.target.value)} required />
              </Label>
            ) : null}
            {authType !== "none" ? (
              <Label className="field">
                <span>{t("mcpServers.fields.credential")}</span>
                <Input
                  type="password"
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                  required
                />
              </Label>
            ) : null}
            <div className="button-row mcp-wide-field">
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
                {t("mcpServers.create")}
              </Button>
              <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                {t("common.close")}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {servers.length === 0 && !creating ? (
        <EmptyState
          title={t("mcpServers.emptyTitle")}
          description={t("mcpServers.emptyDescription")}
          icon={<Server />}
        />
      ) : (
        <div className="mcp-server-layout">
          <Card className="mcp-server-list">
            {servers.map((server) => (
              <button
                type="button"
                key={server.service}
                className={server.service === selectedService ? "mcp-server-row active" : "mcp-server-row"}
                onClick={() => setSelectedService(server.service)}
              >
                <span>
                  <strong>{server.displayName}</strong>
                  <small>{server.endpoint}</small>
                </span>
                <Badge tone={syncTone(server.syncStatus)}>{t(`mcpServers.syncStatus.${server.syncStatus}`)}</Badge>
              </button>
            ))}
          </Card>

          {detail && currentServer ? (
            <Card className="mcp-server-detail">
              <div className="mcp-detail-heading">
                <div>
                  <h3>{detail.server.displayName}</h3>
                  <p>{detail.server.service}</p>
                </div>
                <div className="button-row">
                  <Button variant="outline" size="sm" onClick={syncServer} disabled={busy}>
                    <RefreshCw className={busy ? "spin" : ""} size={14} />
                    {t("mcpServers.sync")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={toggleServer} disabled={busy}>
                    {detail.server.enabled ? t("mcpServers.disable") : t("mcpServers.enable")}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={deleteServer} disabled={busy}>
                    <Trash2 size={14} />
                    {t("mcpServers.delete")}
                  </Button>
                </div>
              </div>
              <dl className="mcp-server-meta">
                <div>
                  <dt>{t("mcpServers.fields.endpoint")}</dt>
                  <dd>{detail.server.endpoint}</dd>
                </div>
                <div>
                  <dt>{t("mcpServers.fields.auth")}</dt>
                  <dd>{detail.server.auth.type}</dd>
                </div>
                <div>
                  <dt>{t("mcpServers.revision")}</dt>
                  <dd>{detail.server.revision}</dd>
                </div>
                <div>
                  <dt>{t("mcpServers.reviewRequired")}</dt>
                  <dd>{reviewCount}</dd>
                </div>
              </dl>
              {detail.server.lastSyncError ? <InlineError message={detail.server.lastSyncError} /> : null}

              <div className="mcp-tools-heading">
                <div>
                  <h3>{t("mcpServers.tools")}</h3>
                  <p>{t("mcpServers.toolsDescription")}</p>
                </div>
                <Button onClick={saveTools} disabled={busy}>
                  <Save size={14} />
                  {t("mcpServers.saveTools")}
                </Button>
              </div>
              <div className="mcp-tool-list">
                {detail.tools.length === 0 ? (
                  <EmptyState
                    density="compact"
                    title={t("mcpServers.noToolsTitle")}
                    description={t("mcpServers.noToolsDescription")}
                  />
                ) : (
                  detail.tools.map((tool) => {
                    const selectable = tool.status !== "removed" && tool.status !== "invalid";
                    return (
                      <label key={tool.upstreamName} className="mcp-tool-row">
                        <input
                          type="checkbox"
                          checked={enabledTools.includes(tool.upstreamName)}
                          disabled={!selectable || busy}
                          onChange={() => toggleTool(tool.upstreamName)}
                        />
                        <span>
                          <strong>{tool.title ?? tool.upstreamName}</strong>
                          <small>{tool.description ?? tool.upstreamName}</small>
                        </span>
                        <Badge tone={toolTone(tool.status)}>{t(`mcpServers.toolStatus.${tool.status}`)}</Badge>
                      </label>
                    );
                  })
                )}
              </div>
            </Card>
          ) : null}
        </div>
      )}
    </section>
  );
}

function syncTone(status: UpstreamMcpServer["syncStatus"]): "success" | "warning" | "error" {
  return status === "ok" ? "success" : status === "error" ? "error" : "warning";
}

function toolTone(status: "available" | "review_required" | "removed" | "invalid") {
  return status === "available" ? "success" : status === "review_required" ? "warning" : "error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

async function reloadServers(setServers: (servers: UpstreamMcpServer[]) => void): Promise<void> {
  setServers(await apiGet<UpstreamMcpServer[]>("/api/mcp-servers"));
}
