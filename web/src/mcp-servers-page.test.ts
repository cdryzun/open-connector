import { I18nProvider } from "@embra/i18n/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createAppI18n } from "./i18n";
import { McpServersPage } from "./mcp-servers-page";

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
