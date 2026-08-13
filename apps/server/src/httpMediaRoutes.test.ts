// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import { AuthSessionId } from "@salchi/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "./config.ts";
import {
  attachmentsRouteLayer,
  projectFaviconRouteLayer,
  workspaceGitImageRouteLayer,
  workspaceImageRouteLayer,
  workspaceVideoRouteLayer,
} from "./http.ts";
import { ServerAuth, type ServerAuthShape } from "./auth/Services/ServerAuth.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";

const SVG_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function expectSvgIsolation(response: Response): void {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toBe(SVG_POLICY);
}

function expectNonSvgIsolation(response: Response): void {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toBeNull();
}

describe("media route response isolation", () => {
  let tempRoot = "";
  let attachmentsDir = "";
  let faviconProject = "";
  let extensionlessFaviconProject = "";
  let workspace = "";
  let gitSvgObjectId = "";
  let handler: (request: Request) => Promise<Response>;
  let dispose: () => Promise<void>;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "salchi-http-media-"));
    attachmentsDir = join(tempRoot, "attachments");
    faviconProject = join(tempRoot, "favicon-project");
    extensionlessFaviconProject = join(tempRoot, "extensionless-favicon-project");
    workspace = join(tempRoot, "workspace");
    for (const directory of [
      attachmentsDir,
      faviconProject,
      extensionlessFaviconProject,
      workspace,
    ]) {
      mkdirSync(directory, { recursive: true });
    }

    writeFileSync(join(attachmentsDir, "attachment.svg"), "<svg/>");
    writeFileSync(join(attachmentsDir, "attachment.png"), "png");
    writeFileSync(join(faviconProject, "favicon.svg"), "<svg>favicon</svg>");
    writeFileSync(
      join(extensionlessFaviconProject, "index.html"),
      '<link rel="icon" href="/icon">',
    );
    mkdirSync(join(extensionlessFaviconProject, "public"), { recursive: true });
    writeFileSync(join(extensionlessFaviconProject, "public", "icon"), "<svg>unsafe</svg>");
    writeFileSync(join(workspace, "image.svg"), "<svg>workspace</svg>");
    writeFileSync(join(workspace, "video.mp4"), "0123456789");
    writeFileSync(join(workspace, "git-image.svg"), "<svg>git</svg>");
    execFileSync("git", ["init", "--quiet"], { cwd: workspace });
    gitSvgObjectId = execFileSync("git", ["hash-object", "-w", "git-image.svg"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();

    const authenticatedSession = {
      sessionId: AuthSessionId.make("http-media-test"),
      subject: "http-media-test",
      method: "browser-session-cookie" as const,
      role: "owner" as const,
      scopes: new Set(),
    };
    const authLayer = Layer.succeed(ServerAuth, {
      authenticateHttpRequest: () => Effect.succeed(authenticatedSession),
    } as unknown as ServerAuthShape);
    const configLayer = Layer.succeed(ServerConfig, {
      attachmentsDir,
    } as ServerConfigShape);
    const routes = Layer.mergeAll(
      attachmentsRouteLayer,
      projectFaviconRouteLayer,
      workspaceImageRouteLayer,
      workspaceVideoRouteLayer,
      workspaceGitImageRouteLayer,
    ).pipe(
      Layer.provideMerge(authLayer),
      Layer.provideMerge(configLayer),
      Layer.provideMerge(ProjectFaviconResolverLive),
      Layer.provideMerge(WorkspacePathsLive),
      Layer.provideMerge(NodeHttpPlatform.layer),
      Layer.provideMerge(NodeServices.layer),
    );
    ({ handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true }));
  });

  afterAll(async () => {
    await dispose();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("applies SVG isolation to attachment responses", async () => {
    const svgResponse = await handler(new Request("http://localhost/attachments/attachment.svg"));
    expect(svgResponse.status).toBe(200);
    expectSvgIsolation(svgResponse);

    const pngResponse = await handler(new Request("http://localhost/attachments/attachment.png"));
    expect(pngResponse.status).toBe(200);
    expectNonSvgIsolation(pngResponse);
  });

  it("isolates resolved and fallback project favicons", async () => {
    const resolvedResponse = await handler(
      new Request(`http://localhost/api/project-favicon?cwd=${encodeURIComponent(faviconProject)}`),
    );
    expect(resolvedResponse.status).toBe(200);
    expectSvgIsolation(resolvedResponse);

    const fallbackResponse = await handler(
      new Request(
        `http://localhost/api/project-favicon?cwd=${encodeURIComponent(extensionlessFaviconProject)}`,
      ),
    );
    expect(fallbackResponse.status).toBe(200);
    expectSvgIsolation(fallbackResponse);
    expect(await fallbackResponse.text()).toContain('data-fallback="project-favicon"');
  });

  it("isolates workspace images and partial video responses", async () => {
    const imageResponse = await handler(
      new Request(
        `http://localhost/api/workspace-image?cwd=${encodeURIComponent(workspace)}&relativePath=image.svg`,
      ),
    );
    expect(imageResponse.status).toBe(200);
    expectSvgIsolation(imageResponse);

    const videoResponse = await handler(
      new Request(
        `http://localhost/api/workspace-video?cwd=${encodeURIComponent(workspace)}&relativePath=video.mp4`,
        { headers: { Range: "bytes=1-3" } },
      ),
    );
    expect(videoResponse.status).toBe(206);
    expect(videoResponse.headers.get("content-range")).toBe("bytes 1-3/10");
    expectNonSvgIsolation(videoResponse);
  });

  it("applies SVG isolation to Git image responses", async () => {
    const response = await handler(
      new Request(
        `http://localhost/api/workspace-git-image?cwd=${encodeURIComponent(workspace)}&relativePath=git-image.svg&objectId=${gitSvgObjectId}`,
      ),
    );
    expect(response.status).toBe(200);
    expectSvgIsolation(response);
  });
});
