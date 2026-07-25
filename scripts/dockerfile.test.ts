import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const npmInstallBlockPattern =
  /RUN --mount=type=cache,[\s\S]*?(?=\n(?:RUN|COPY|VOLUME|EXPOSE|HEALTHCHECK|CMD|FROM|ENV|WORKDIR)\b|$)/g;

describe("Docker image dependency installation", () => {
  it("shares the npm cache and retries transient registry failures in every image stage", async () => {
    const dockerfile = await readFile(new URL("../docker/Dockerfile", import.meta.url), "utf8");
    const installBlocks = dockerfile.match(npmInstallBlockPattern) ?? [];

    expect(installBlocks).toHaveLength(2);
    for (const installBlock of installBlocks) {
      expect(installBlock).toContain("id=open-connector-npm-cache");
      expect(installBlock).toContain("target=/root/.npm");
      expect(installBlock).toContain("sharing=locked");
      expect(installBlock).toContain("npm ci");
      expect(installBlock).toContain("--fetch-retries=5");
      expect(installBlock).toContain("--fetch-retry-mintimeout=10000");
      expect(installBlock).toContain("--fetch-retry-maxtimeout=60000");
      expect(installBlock).toContain("--fetch-timeout=120000");
    }
  });

  it("builds platform-independent application assets on the native builder platform", async () => {
    const dockerfile = await readFile(new URL("../docker/Dockerfile", import.meta.url), "utf8");
    const nativeBuildStages = dockerfile.match(/^FROM --platform=\$BUILDPLATFORM .+ AS build$/gm) ?? [];

    expect(nativeBuildStages).toEqual(["FROM --platform=$BUILDPLATFORM node:24-alpine AS build"]);
  });
});
