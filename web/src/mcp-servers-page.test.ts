import { I18nProvider } from "@embra/i18n/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createAppI18n } from "./i18n";
import { McpServersPage, nextBulkToolSelection } from "./mcp-servers-page";

describe("McpServersPage", () => {
  it("renders the empty-state registration workflow", () => {
    const markup = renderToStaticMarkup(
      createElement(I18nProvider, { i18n: createAppI18n("en") }, createElement(McpServersPage, { onRefresh() {} })),
    );

    expect(markup).toContain("Upstream MCP Servers");
    expect(markup).toContain("Add server");
    expect(markup).toContain("No upstream MCP servers");
  });
});

describe("nextBulkToolSelection", () => {
  it("selects every selectable tool from a partial selection", () => {
    expect(nextBulkToolSelection(["read", "write"], ["read"])).toEqual(["read", "write"]);
  });

  it("clears the selection when every selectable tool is selected", () => {
    expect(nextBulkToolSelection(["read", "write"], ["read", "write"])).toEqual([]);
  });

  it("keeps the selection empty when no tools are selectable", () => {
    expect(nextBulkToolSelection([], [])).toEqual([]);
  });
});
