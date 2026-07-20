import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EnvironmentId, type EnvironmentApi } from "@salchi/contracts";
import { createElement } from "react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import { type WorkspaceFilePreviewTarget } from "../workspaceFilePreview";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { RightPanelSheet } from "./RightPanelSheet";
import { WorkspaceFilePreviewPanel } from "./WorkspaceFilePreviewPanel";

const {
  getWorkingTreeDiffMock,
  gitStatusMockState,
  refreshGitStatusMock,
  resolveEnvironmentHttpUrlMock,
  useGitStatusMock,
} = vi.hoisted(() => ({
  getWorkingTreeDiffMock: vi.fn(async () => ({ diff: "" })),
  refreshGitStatusMock: vi.fn(async () => null),
  gitStatusMockState: (() => {
    const state: {
      current: {
        cause: unknown;
        data: unknown;
        error: unknown;
        isPending: boolean;
      };
    } = {
      current: {
        cause: null,
        data: null,
        error: null,
        isPending: false,
      },
    };
    return state;
  })(),
  resolveEnvironmentHttpUrlMock: vi.fn(
    (input: { pathname: string; searchParams?: Record<string, string> }) => {
      const url = new URL(`http://environment.test${input.pathname}`);
      if (input.searchParams) {
        url.search = new URLSearchParams(input.searchParams).toString();
      }
      return url.toString();
    },
  ),
  useGitStatusMock: vi.fn(),
}));

useGitStatusMock.mockImplementation(() => gitStatusMockState.current);

vi.mock("../environments/runtime", () => ({
  addSavedEnvironment: vi.fn(),
  connectDesktopSshEnvironment: vi.fn(),
  disconnectSavedEnvironment: vi.fn(),
  ensureEnvironmentConnectionBootstrapped: vi.fn(),
  getEnvironmentHttpBaseUrl: vi.fn(() => "http://environment.test"),
  getPrimaryEnvironmentConnection: vi.fn(() => null),
  getSavedEnvironmentRecord: vi.fn(() => null),
  getSavedEnvironmentRuntimeState: vi.fn(() => null),
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: vi.fn(() => []),
  readEnvironmentConnection: vi.fn(() => null),
  reconnectSavedEnvironment: vi.fn(),
  removeSavedEnvironment: vi.fn(),
  requireEnvironmentConnection: vi.fn(() => {
    throw new Error("Environment connection not found.");
  }),
  resetEnvironmentServiceForTests: vi.fn(),
  resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
  resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
  resolveEnvironmentHttpUrl: resolveEnvironmentHttpUrlMock,
  startEnvironmentConnectionService: vi.fn(),
  subscribeEnvironmentConnections: vi.fn(() => () => undefined),
  useSavedEnvironmentRegistryStore: vi.fn(() => ({})),
  useSavedEnvironmentRuntimeStore: vi.fn(() => ({})),
  waitForSavedEnvironmentRegistryHydration: vi.fn(async () => undefined),
}));

vi.mock("../lib/gitStatusState", () => ({
  applyGitStatusLocalUpdate: () => undefined,
  refreshGitStatus: refreshGitStatusMock,
  resetGitStatusStateForTests: () => undefined,
  useGitStatus: useGitStatusMock,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-file-preview-real-diff-browser");
const DEFAULT_CONTENTS = "export const value = 1;\nconsole.log(value);\n";
const MODIFIED_FILE_DIFF = [
  "diff --git a/src/App.tsx b/src/App.tsx",
  "index 1111111..2222222 100644",
  "--- a/src/App.tsx",
  "+++ b/src/App.tsx",
  "@@ -1,2 +1,2 @@",
  " export const value = 1;",
  "-console.log(oldValue);",
  "+console.log(value);",
].join("\n");
const TWO_HUNK_WITH_DELETION_ONLY_DIFF = [
  "diff --git a/src/delete-nav.ts b/src/delete-nav.ts",
  "index 1111111..2222222 100644",
  "--- a/src/delete-nav.ts",
  "+++ b/src/delete-nav.ts",
  "@@ -1,2 +1,2 @@",
  "-old one",
  "+new one",
  " line two",
  "@@ -5,2 +5,1 @@",
  " line five",
  "-old six",
].join("\n");

function resetGitStatusMock() {
  gitStatusMockState.current = {
    cause: null,
    data: null,
    error: null,
    isPending: false,
  };
}

function setGitStatusMock(
  files: Array<{
    deletions?: number;
    insertions?: number;
    path: string;
    status?: "added" | "modified" | "deleted" | "renamed" | "untracked";
  }>,
) {
  gitStatusMockState.current = {
    cause: null,
    data: {
      aheadCount: 0,
      aheadOfDefaultCount: 0,
      behindCount: 0,
      hasPrimaryRemote: false,
      hasUpstream: false,
      hasWorkingTreeChanges: files.length > 0,
      isDefaultRef: true,
      isRepo: true,
      pr: null,
      refName: "main",
      workingTree: {
        deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
        files: files.map((file) => ({
          deletions: file.deletions ?? 0,
          insertions: file.insertions ?? 0,
          path: file.path,
          status: file.status ?? "modified",
        })),
        insertions: files.reduce((total, file) => total + (file.insertions ?? 0), 0),
      },
    },
    error: null,
    isPending: false,
  };
}

function createMockEnvironmentApi(
  readFile: EnvironmentApi["projects"]["readFile"],
): EnvironmentApi {
  return {
    projects: {
      readFile,
      searchEntries: vi.fn(),
      listDirectoryEntries: vi.fn(),
      writeFile: vi.fn(),
    },
    vcs: {
      getWorkingTreeDiff: getWorkingTreeDiffMock,
    },
  } as unknown as EnvironmentApi;
}

function createTarget(input: { relativePath: string; line?: number }): WorkspaceFilePreviewTarget {
  return {
    environmentId: ENVIRONMENT_ID,
    cwd: "/repo/project",
    displayPath: input.relativePath,
    relativePath: input.relativePath,
    ...(input.line ? { line: input.line } : {}),
  };
}

async function renderPreview(
  input: {
    contents?: string;
    line?: number;
    relativePath?: string;
    sheetOnClose?: () => void;
  } = {},
) {
  const contents = input.contents ?? DEFAULT_CONTENTS;
  const relativePath = input.relativePath ?? "src/App.tsx";
  const readFile = vi.fn(async () => ({
    relativePath,
    contents,
    sizeBytes: new TextEncoder().encode(contents).byteLength,
    truncated: false,
  }));
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, createMockEnvironmentApi(readFile));

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  const host = document.createElement("div");
  host.style.height = "260px";
  host.style.width = "720px";
  document.body.append(host);

  const previewPanel = createElement(WorkspaceFilePreviewPanel, {
    mode: input.sheetOnClose ? "sheet" : "sidebar",
    target: createTarget(
      input.line === undefined ? { relativePath } : { relativePath, line: input.line },
    ),
  });
  const previewContent = input.sheetOnClose ? (
    <RightPanelSheet open={true} onClose={input.sheetOnClose}>
      {previewPanel}
    </RightPanelSheet>
  ) : (
    previewPanel
  );

  const screen = await render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(DiffWorkerPoolProvider, null, previewContent),
    ),
    { container: host },
  );

  await vi.waitFor(() => {
    expect(readFile).toHaveBeenCalledWith({
      cwd: "/repo/project",
      relativePath,
    });
  });

  return {
    readFile,
    async cleanup() {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    },
  };
}

function getPreviewShadowRoot(): ShadowRoot | null {
  return document.querySelector<HTMLElement>(".workspace-file-preview-render")?.shadowRoot ?? null;
}

function getInlineDiffShadowRoot(): ShadowRoot | null {
  const inlineDiffHost = document
    .querySelector("[data-testid='workspace-file-inline-diff']")
    ?.querySelector("diffs-container");
  return inlineDiffHost?.shadowRoot ?? null;
}

async function waitForInlineDiffShadowText(text: string): Promise<void> {
  await vi.waitFor(() => {
    const shadowRoot = getInlineDiffShadowRoot();
    expect(shadowRoot).not.toBeNull();
    expect(shadowRoot?.textContent).toContain(text);
  }, 10_000);
}

function getPreviewHost(): HTMLElement {
  const host = document.querySelector<HTMLElement>(".workspace-file-preview-render");
  if (!host) {
    throw new Error("Preview host not found.");
  }
  return host;
}

async function waitForPreviewShadowElement(selector: string): Promise<HTMLElement> {
  let element: HTMLElement | null = null;
  await vi.waitFor(() => {
    const shadowRoot = getPreviewShadowRoot();
    expect(shadowRoot).not.toBeNull();
    element = shadowRoot?.querySelector<HTMLElement>(selector) ?? null;
    expect(element).not.toBeNull();
  }, 10_000);
  if (!element) {
    throw new Error(`Preview shadow element not found: ${selector}`);
  }
  return element;
}

function dispatchComposedPointerTap(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  dispatchComposedPointerTapAt(element, {
    clientX: rect.left + Math.min(2, Math.max(0, rect.width / 2)),
    clientY: rect.top + Math.max(1, rect.height / 2),
  });
}

function dispatchComposedPointerTapAt(
  element: HTMLElement,
  point: { clientX: number; clientY: number },
) {
  for (const type of ["pointerdown", "pointerup"]) {
    element.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: point.clientX,
        clientY: point.clientY,
        composed: true,
        pointerId: 1,
        pointerType: "mouse",
      }),
    );
  }
}

function dispatchComposedClick(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(2, Math.max(0, rect.width / 2)),
      clientY: rect.top + Math.max(1, rect.height / 2),
      composed: true,
    }),
  );
}

async function clickHostAtElementPoint(element: HTMLElement, input: { x: number; y: number }) {
  const host = getPreviewHost();
  const hostRect = host.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  await userEvent.click(host, {
    position: {
      x: elementRect.left - hostRect.left + input.x,
      y: elementRect.top - hostRect.top + input.y,
    },
  });
}

async function waitForAnimationFrame() {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

describe("WorkspaceFilePreviewPanel real diff renderer", () => {
  beforeEach(() => {
    getWorkingTreeDiffMock.mockResolvedValue({ diff: MODIFIED_FILE_DIFF });
    resetGitStatusMock();
    setGitStatusMock([{ deletions: 1, insertions: 1, path: "src/App.tsx" }]);
    useGitStatusMock.mockImplementation(() => gitStatusMockState.current);
  });

  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    getWorkingTreeDiffMock.mockReset();
    refreshGitStatusMock.mockReset();
    refreshGitStatusMock.mockResolvedValue(null);
    resetGitStatusMock();
    resolveEnvironmentHttpUrlMock.mockClear();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("opens and closes the inline diff from a real shadow-DOM gutter marker click", async () => {
    const mounted = await renderPreview();
    try {
      const marker = await waitForPreviewShadowElement('[data-column-number="2"]');

      dispatchComposedPointerTap(marker);
      await vi.waitFor(() => {
        expect(document.querySelector("[data-testid='workspace-file-inline-diff']")).not.toBeNull();
      });

      const updatedMarker = await waitForPreviewShadowElement('[data-column-number="2"]');
      dispatchComposedPointerTap(updatedMarker);
      await vi.waitFor(() => {
        expect(document.querySelector("[data-testid='workspace-file-inline-diff']")).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the inline diff from a real screen-coordinate click on the painted gutter marker", async () => {
    const mounted = await renderPreview();
    try {
      const marker = await waitForPreviewShadowElement('[data-column-number="2"]');

      await clickHostAtElementPoint(marker, { x: 2, y: 10 });
      await vi.waitFor(() => {
        expect(document.querySelector("[data-testid='workspace-file-inline-diff']")).not.toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("ignores a pointer tap retargeted to the gutter without the marker in the event path", async () => {
    const mounted = await renderPreview();
    try {
      const marker = await waitForPreviewShadowElement('[data-column-number="2"]');
      const gutter = marker.closest<HTMLElement>("[data-gutter]");
      if (!gutter) {
        throw new Error("Preview gutter not found.");
      }
      const markerRect = marker.getBoundingClientRect();

      dispatchComposedPointerTapAt(gutter, {
        clientX: markerRect.left + 2,
        clientY: markerRect.top + 10,
      });
      await waitForAnimationFrame();
      expect(document.querySelector("[data-testid='workspace-file-inline-diff']")).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not open the inline diff from a real shadow-DOM marked code line click", async () => {
    const mounted = await renderPreview();
    try {
      const line = await waitForPreviewShadowElement('[data-line="2"]');

      dispatchComposedClick(line);
      await waitForAnimationFrame();
      expect(document.querySelector("[data-testid='workspace-file-inline-diff']")).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not open an inline diff from a real shadow-DOM unmarked line click", async () => {
    const mounted = await renderPreview();
    try {
      const line = await waitForPreviewShadowElement('[data-line="1"]');

      dispatchComposedClick(line);
      await waitForAnimationFrame();
      expect(document.querySelector("[data-testid='workspace-file-inline-diff']")).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("navigates from a modified hunk into a deleted-only hunk without closing the sheet", async () => {
    const onClose = vi.fn();
    getWorkingTreeDiffMock.mockResolvedValue({ diff: TWO_HUNK_WITH_DELETION_ONLY_DIFF });
    setGitStatusMock([{ deletions: 2, insertions: 1, path: "src/delete-nav.ts" }]);

    const mounted = await renderPreview({
      contents: ["new one", "line two", "line three", "line four", "line five"].join("\n"),
      relativePath: "src/delete-nav.ts",
      sheetOnClose: onClose,
    });
    try {
      const firstMarker = await waitForPreviewShadowElement('[data-column-number="1"]');

      dispatchComposedPointerTap(firstMarker);
      await vi.waitFor(() => {
        expect(document.querySelector("[data-testid='workspace-file-inline-diff']")).not.toBeNull();
        expect(
          document.querySelector<HTMLElement>("[data-testid='workspace-file-inline-diff']")
            ?.textContent,
        ).toContain("Working tree change 1 of 2");
      });
      await waitForInlineDiffShadowText("old one");

      document.querySelector<HTMLButtonElement>('button[aria-label="Next change"]')?.click();
      await vi.waitFor(() => {
        expect(
          document.querySelectorAll("[data-testid='workspace-file-inline-diff']"),
        ).toHaveLength(1);
        expect(
          document.querySelector<HTMLElement>("[data-testid='workspace-file-inline-diff']")
            ?.textContent,
        ).toContain("Working tree change 2 of 2");
      });
      await waitForInlineDiffShadowText("old six");
      expect(getInlineDiffShadowRoot()?.textContent).not.toContain("old one");
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });
});
