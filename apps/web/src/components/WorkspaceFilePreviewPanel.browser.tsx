import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EnvironmentId, TurnId, type EnvironmentApi } from "@salchi/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createElement, type ComponentProps, type CSSProperties, type ReactNode } from "react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import { FILE_PREVIEW_WORD_WRAP_STORAGE_KEY } from "../filePreviewPreferences";
import { resetColorTheme, setColorThemeSelection } from "../hooks/useColorTheme";
import type {
  WorkspaceFilePanelHistoryEntry,
  WorkspaceFilePreviewTarget,
} from "../workspaceFilePreview";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { WorkspaceFilePreviewPanel } from "./WorkspaceFilePreviewPanel";

const {
  EditorMock,
  fileRenderCalls,
  getWorkingTreeDiffMock,
  gitStatusMockState,
  refreshGitStatusMock,
  resolveEnvironmentHttpUrlMock,
  useGitStatusMock,
  virtualizerMounts,
} = vi.hoisted(() => ({
  EditorMock: class EditorMock {
    readonly cleanUp = vi.fn();
    constructor(
      readonly options: {
        onChange?: (file: { contents: string; name?: string; cacheKey?: string }) => void;
      } = {},
    ) {}
  },
  fileRenderCalls: [] as Array<{
    file: { contents: string; name?: string; lang?: string; cacheKey?: string };
    contentEditable?: boolean;
    lineAnnotations?: Array<{ lineNumber: number; metadata?: { hunkId: string } }>;
    options?: {
      lineHoverHighlight?: string;
      onLineClick?: (event: { lineNumber: number }) => void;
      onLineNumberClick?: (event: { lineNumber: number }) => void;
      overflow?: string;
      theme?: string;
      themeType?: string;
      unsafeCSS?: string;
    };
    renderAnnotation?: (annotation: {
      lineNumber: number;
      metadata?: { hunkId: string };
    }) => ReactNode;
    selectedLines?: { start: number; end: number } | null;
    style?: CSSProperties;
  }>,
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
  useGitStatusMock: vi.fn(),
  resolveEnvironmentHttpUrlMock: vi.fn(
    (input: { pathname: string; searchParams?: Record<string, string> }) => {
      const url = new URL(`http://environment.test${input.pathname}`);
      if (input.searchParams) {
        url.search = new URLSearchParams(input.searchParams).toString();
      }
      return url.toString();
    },
  ),
  virtualizerMounts: [] as Array<{
    className: string | undefined;
    contentClassName: string | undefined;
  }>,
}));

useGitStatusMock.mockImplementation(() => gitStatusMockState.current);

vi.mock("@pierre/diffs/editor", () => ({
  Editor: EditorMock,
}));

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

vi.mock("@pierre/diffs/react", async () => {
  const React = await import("react");
  const EditorContext = React.createContext<InstanceType<typeof EditorMock> | undefined>(undefined);

  return {
    EditorProvider: ({
      children,
      editor,
    }: {
      children: ReactNode;
      editor: InstanceType<typeof EditorMock>;
    }) => React.createElement(EditorContext.Provider, { value: editor }, children),
    FileDiff: (props: { fileDiff: { cacheKey?: string; name: string } }) =>
      React.createElement("div", {
        "data-cache-key": props.fileDiff.cacheKey,
        "data-file-name": props.fileDiff.name,
        "data-testid": "workspace-inline-file-diff",
      }),
    VirtualizerContext: React.createContext(undefined),
    WorkerPoolContextProvider: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useWorkerPool: () => ({
      getDiffRenderOptions: () => ({ theme: "pierre-dark" }),
      setRenderOptions: vi.fn(async () => undefined),
    }),
    Virtualizer: ({
      children,
      className,
      contentClassName,
    }: {
      children: ReactNode;
      className?: string;
      contentClassName?: string;
    }) => {
      React.useEffect(() => {
        virtualizerMounts.push({ className, contentClassName });
      }, [className, contentClassName]);

      return React.createElement(
        "div",
        {
          className,
          "data-testid": "workspace-file-virtualizer",
          style: { height: "100%", overflow: "auto" },
        },
        React.createElement("div", { className: contentClassName }, children),
      );
    },
    File: (props: {
      file: { contents: string; name?: string; lang?: string; cacheKey?: string };
      lineAnnotations?: Array<{ lineNumber: number; metadata?: { hunkId: string } }>;
      options?: {
        lineHoverHighlight?: string;
        onLineClick?: (event: { lineNumber: number }) => void;
        onLineNumberClick?: (event: { lineNumber: number }) => void;
        overflow?: string;
        theme?: string;
        themeType?: string;
        unsafeCSS?: string;
      };
      renderAnnotation?: (annotation: {
        lineNumber: number;
        metadata?: { hunkId: string };
      }) => ReactNode;
      selectedLines?: { start: number; end: number } | null;
      style?: CSSProperties;
      contentEditable?: boolean;
    }) => {
      fileRenderCalls.push(props);
      const editor = React.useContext(EditorContext);
      const [editableContents, setEditableContents] = React.useState(props.file.contents);
      React.useEffect(() => {
        setEditableContents(props.file.contents);
      }, [props.file.contents]);
      const renderedContents = props.contentEditable ? editableContents : props.file.contents;
      return React.createElement(
        "div",
        {
          "data-content-editable": props.contentEditable ? "true" : undefined,
          "data-cache-key": props.file.cacheKey,
          "data-lang": props.file.lang,
          "data-overflow": props.options?.overflow,
          "data-testid": "workspace-file-render",
          style: props.style,
        },
        props.contentEditable
          ? React.createElement("textarea", {
              "aria-label": `Edit ${props.file.name ?? "file"}`,
              onChange: (event: { currentTarget: HTMLTextAreaElement }) => {
                const nextContents = event.currentTarget.value;
                setEditableContents(nextContents);
                editor?.options.onChange?.({ ...props.file, contents: nextContents });
              },
              value: editableContents,
            })
          : null,
        renderedContents.split("\n").flatMap((line, index) => {
          const lineNumber = index + 1;
          const selected =
            props.selectedLines !== null &&
            props.selectedLines !== undefined &&
            lineNumber >= props.selectedLines.start &&
            lineNumber <= props.selectedLines.end;
          const annotation = props.lineAnnotations?.find(
            (candidate) => candidate.lineNumber === lineNumber,
          );

          const lineElement = React.createElement(
            "div",
            {
              "data-line": lineNumber,
              "data-selected-line": selected ? "single" : undefined,
              key: lineNumber,
              onClick: () => props.options?.onLineClick?.({ lineNumber }),
              style: { display: "grid", gridTemplateColumns: "3.5rem 1fr", height: 20 },
            },
            React.createElement(
              "span",
              {
                "data-column-number": lineNumber,
                onClick: (event: { stopPropagation: () => void }) => {
                  event.stopPropagation();
                  props.options?.onLineNumberClick?.({ lineNumber });
                },
              },
              String(lineNumber),
            ),
            React.createElement("code", null, line.length > 0 ? line : " "),
          );

          if (!annotation || !props.renderAnnotation) {
            return [lineElement];
          }

          return [
            lineElement,
            React.createElement(
              "div",
              {
                "data-testid": "workspace-file-render-annotation",
                key: `annotation-${lineNumber}`,
              },
              props.renderAnnotation(annotation),
            ),
          ];
        }),
      );
    },
  };
});

vi.mock("../lib/gitStatusState", () => ({
  applyGitStatusLocalUpdate: () => undefined,
  refreshGitStatus: refreshGitStatusMock,
  resetGitStatusStateForTests: () => undefined,
  useGitStatus: useGitStatusMock,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-file-preview-browser");
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
const DELETED_ONLY_FILE_DIFF = [
  "diff --git a/src/deleted.ts b/src/deleted.ts",
  "index 1111111..2222222 100644",
  "--- a/src/deleted.ts",
  "+++ b/src/deleted.ts",
  "@@ -1,3 +1,2 @@",
  " line one",
  "-line two",
  " line three",
].join("\n");
const TWO_HUNK_FILE_DIFF = [
  "diff --git a/src/multi.ts b/src/multi.ts",
  "index 1111111..2222222 100644",
  "--- a/src/multi.ts",
  "+++ b/src/multi.ts",
  "@@ -1,2 +1,2 @@",
  "-old one",
  "+new one",
  " line two",
  "@@ -5,2 +5,2 @@",
  " line five",
  "-old six",
  "+new six",
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
  writeFile: EnvironmentApi["projects"]["writeFile"] = vi.fn(async (input) => ({
    relativePath: input.relativePath,
  })),
): EnvironmentApi {
  return {
    projects: {
      readFile,
      searchEntries: vi.fn(),
      listDirectoryEntries: vi.fn(),
      writeFile,
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

async function renderPreview(input: {
  backTarget?: WorkspaceFilePanelHistoryEntry;
  contents?: string;
  line?: number;
  onAddFileToInput?: (relativePath: string) => void;
  onBack?: () => void;
  onShowExplorer?: () => void;
  panelOpen?: boolean;
  relativePath?: string;
  showExplorerButton?: boolean;
  sizeBytes?: number;
  truncated?: boolean;
  writeFile?: EnvironmentApi["projects"]["writeFile"];
}) {
  const contents = input.contents ?? DEFAULT_CONTENTS;
  const relativePath = input.relativePath ?? "src/App.tsx";
  const readFile = vi.fn(async () => ({
    relativePath,
    contents,
    sizeBytes: input.sizeBytes ?? new TextEncoder().encode(contents).byteLength,
    truncated: input.truncated ?? false,
  }));
  const writeFile =
    input.writeFile ??
    vi.fn(async (writeInput) => ({
      relativePath: writeInput.relativePath,
    }));
  __setEnvironmentApiOverrideForTests(
    ENVIRONMENT_ID,
    createMockEnvironmentApi(readFile, writeFile),
  );

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

  const panelProps = {
    mode: "sidebar" as const,
    target: createTarget(
      input.line === undefined ? { relativePath } : { relativePath, line: input.line },
    ),
    ...(input.onAddFileToInput ? { onAddFileToInput: input.onAddFileToInput } : {}),
    ...(input.backTarget ? { backTarget: input.backTarget } : {}),
    ...(input.onBack ? { onBack: input.onBack } : {}),
    ...(input.onShowExplorer ? { onShowExplorer: input.onShowExplorer } : {}),
    ...(input.panelOpen !== undefined ? { panelOpen: input.panelOpen } : {}),
    ...(input.showExplorerButton !== undefined
      ? { showExplorerButton: input.showExplorerButton }
      : {}),
  } satisfies ComponentProps<typeof WorkspaceFilePreviewPanel>;

  const renderPanel = (props: ComponentProps<typeof WorkspaceFilePreviewPanel>) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(DiffWorkerPoolProvider, null, createElement(WorkspaceFilePreviewPanel, props)),
    );

  const screen = await render(renderPanel(panelProps), { container: host });

  await vi.waitFor(() => {
    expect(readFile).toHaveBeenCalledWith({
      cwd: "/repo/project",
      relativePath,
    });
  });
  await vi.waitFor(() => {
    expect(document.querySelector("[data-testid='workspace-file-render']")).not.toBeNull();
  });

  return {
    readFile,
    writeFile,
    rerenderPanel: async (nextProps: Partial<ComponentProps<typeof WorkspaceFilePreviewPanel>>) => {
      await screen.rerender(renderPanel({ ...panelProps, ...nextProps }));
    },
    async cleanup() {
      await screen.unmount();
      queryClient.clear();
      host.remove();
    },
  };
}

async function renderImagePreview(
  input: { onAddFileToInput?: (relativePath: string) => void; relativePath?: string } = {},
) {
  const relativePath = input.relativePath ?? "assets/chart.png";
  const readFile = vi.fn(async () => {
    throw new Error("Image previews should not read text file contents.");
  });
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

  const screen = await render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        DiffWorkerPoolProvider,
        null,
        createElement(WorkspaceFilePreviewPanel, {
          mode: "sidebar",
          target: createTarget({ relativePath }),
          ...(input.onAddFileToInput ? { onAddFileToInput: input.onAddFileToInput } : {}),
        }),
      ),
    ),
    { container: host },
  );

  await vi.waitFor(() => {
    expect(
      document.querySelector('img[src^="http://environment.test/api/workspace-image"]'),
    ).not.toBeNull();
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

async function renderVideoPreview(
  input: { onAddFileToInput?: (relativePath: string) => void; relativePath?: string } = {},
) {
  const relativePath = input.relativePath ?? "captures/demo.mp4";
  const readFile = vi.fn(async () => {
    throw new Error("Video previews should not read text file contents.");
  });
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

  const screen = await render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        DiffWorkerPoolProvider,
        null,
        createElement(WorkspaceFilePreviewPanel, {
          mode: "sidebar",
          target: createTarget({ relativePath }),
          ...(input.onAddFileToInput ? { onAddFileToInput: input.onAddFileToInput } : {}),
        }),
      ),
    ),
    { container: host },
  );

  await vi.waitFor(() => {
    expect(
      document.querySelector('video[src^="http://environment.test/api/workspace-video"]'),
    ).not.toBeNull();
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

async function waitForMarkerCss(lineNumber: number) {
  await vi.waitFor(() => {
    expect(fileRenderCalls.at(-1)?.options?.unsafeCSS).toContain(
      `[data-column-number="${lineNumber}"]`,
    );
  });
}

function latestFileUnsafeCss(): string {
  return fileRenderCalls.at(-1)?.options?.unsafeCSS ?? "";
}

// The panel toggles the inline diff from a pointer tap (pointerdown + pointerup) on the
// gutter rather than a `click`, so taps must be simulated with pointer events.
function tapElement(element: Element | null | undefined): void {
  if (!element) {
    return;
  }
  const init = { bubbles: true, composed: true, pointerId: 1, clientX: 0, clientY: 0 };
  element.dispatchEvent(new PointerEvent("pointerdown", init));
  element.dispatchEvent(new PointerEvent("pointerup", init));
}

async function waitForAnimationFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }
}

describe("WorkspaceFilePreviewPanel", () => {
  beforeEach(() => {
    getWorkingTreeDiffMock.mockResolvedValue({ diff: "" });
    resetGitStatusMock();
    useGitStatusMock.mockImplementation(() => gitStatusMockState.current);
  });

  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    fileRenderCalls.length = 0;
    virtualizerMounts.length = 0;
    getWorkingTreeDiffMock.mockReset();
    refreshGitStatusMock.mockReset();
    refreshGitStatusMock.mockResolvedValue(null);
    resetGitStatusMock();
    resolveEnvironmentHttpUrlMock.mockClear();
    resetColorTheme();
    window.localStorage.removeItem(FILE_PREVIEW_WORD_WRAP_STORAGE_KEY);
    window.localStorage.removeItem("salchi:colorTheme");
    window.localStorage.removeItem("salchi:theme");
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders a small highlighted file through the file renderer", async () => {
    const mounted = await renderPreview({});
    try {
      const rendered = document.querySelector<HTMLElement>("[data-testid='workspace-file-render']");
      expect(rendered?.dataset.lang).toBe("tsx");
      expect(rendered?.dataset.cacheKey).toContain("file-preview");
      expect(document.querySelector("code")?.textContent).toBe("export const value = 1;");
      expect(document.querySelector('[data-column-number="1"]')?.textContent).toBe("1");
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the selected syntax theme in file preview cache keys and render options", async () => {
    localStorage.setItem("salchi:theme", "dark");
    setColorThemeSelection("default", "github-dark-default");

    const mounted = await renderPreview({});
    try {
      await vi.waitFor(() => {
        expect(fileRenderCalls.at(-1)?.options?.theme).toBe("github-dark-default");
      });

      const rendered = document.querySelector<HTMLElement>("[data-testid='workspace-file-render']");
      expect(rendered?.dataset.cacheKey).toContain("github-dark-default");
      expect(fileRenderCalls.at(-1)?.options).toMatchObject({
        theme: "github-dark-default",
        themeType: "dark",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("sets host-level preview backgrounds before shadow CSS renders", async () => {
    const mounted = await renderPreview({});
    try {
      await vi.waitFor(() => {
        expect(fileRenderCalls.at(-1)?.style).toMatchObject({
          "--diffs-bg": "var(--background)",
          "--diffs-light-bg": "var(--background)",
          "--diffs-dark-bg": "var(--background)",
          "--diffs-bg-buffer-override": "var(--background)",
          backgroundColor: "var(--background)",
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("remounts the preview virtualizer once after a closed panel opens", async () => {
    const mounted = await renderPreview({ panelOpen: false });
    try {
      await vi.waitFor(() => {
        expect(virtualizerMounts).toHaveLength(1);
      });
      await waitForAnimationFrames(3);
      expect(virtualizerMounts).toHaveLength(1);

      await mounted.rerenderPanel({ panelOpen: true });
      await vi.waitFor(() => {
        expect(virtualizerMounts).toHaveLength(2);
      });
      await waitForAnimationFrames(3);
      expect(virtualizerMounts).toHaveLength(2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("remounts the preview virtualizer when a preserved panel is reopened", async () => {
    const mounted = await renderPreview({ panelOpen: true });
    try {
      // Initial open settles layout and remounts the virtualizer against real dimensions.
      await vi.waitFor(() => {
        expect(virtualizerMounts).toHaveLength(2);
      });
      await waitForAnimationFrames(3);
      expect(virtualizerMounts).toHaveLength(2);

      // Preserve the panel (hidden), then reopen the same file via swipe.
      await mounted.rerenderPanel({ panelOpen: false });
      await waitForAnimationFrames(3);
      await mounted.rerenderPanel({ panelOpen: true });

      // The virtualizer must remount so it measures against real dimensions again
      // instead of leaving a blank page until the user scrolls.
      await vi.waitFor(() => {
        expect(virtualizerMounts).toHaveLength(3);
      });
      await waitForAnimationFrames(3);
      expect(virtualizerMounts).toHaveLength(3);
    } finally {
      await mounted.cleanup();
    }
  });

  it("requests an all-changes working tree diff for a changed preview file", async () => {
    getWorkingTreeDiffMock.mockResolvedValue({ diff: MODIFIED_FILE_DIFF });
    setGitStatusMock([{ deletions: 1, insertions: 1, path: "src/App.tsx" }]);

    const mounted = await renderPreview({});
    try {
      await vi.waitFor(() => {
        expect(getWorkingTreeDiffMock).toHaveBeenCalledWith({
          cwd: "/repo/project",
          filePaths: ["src/App.tsx"],
          ignoreWhitespace: false,
          target: "all",
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not request a working tree diff for clean preview files", async () => {
    setGitStatusMock([]);

    const mounted = await renderPreview({});
    try {
      await vi.waitFor(() => {
        expect(document.querySelector("[data-testid='workspace-file-render']")).not.toBeNull();
      });
      expect(getWorkingTreeDiffMock).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles an inline diff annotation when clicking a marked gutter", async () => {
    getWorkingTreeDiffMock.mockResolvedValue({ diff: MODIFIED_FILE_DIFF });
    setGitStatusMock([{ deletions: 1, insertions: 1, path: "src/App.tsx" }]);

    const mounted = await renderPreview({});
    try {
      await waitForMarkerCss(2);
      const unsafeCSS = latestFileUnsafeCss();
      expect(fileRenderCalls.at(-1)?.options?.lineHoverHighlight).toBe("number");
      // The inline diff toggles from a pointer tap on the gutter (handled by the panel),
      // so the renderer's own line click callbacks stay unwired.
      expect(fileRenderCalls.at(-1)?.options?.onLineClick).toBeUndefined();
      expect(fileRenderCalls.at(-1)?.options?.onLineNumberClick).toBeUndefined();
      expect(unsafeCSS).toContain("cursor: pointer !important;");
      // The marked gutter must be tappable on touch: manipulation removes the tap delay
      // and the grow-on-hover is gated to hover pointers so a tap is not swallowed.
      expect(unsafeCSS).toContain("touch-action: manipulation !important;");
      expect(unsafeCSS).toContain("@media (hover: hover) {");
      expect(unsafeCSS).toContain(
        "background-image: linear-gradient(var(--warning), var(--warning)) !important;",
      );
      expect(unsafeCSS).toContain("background-position: left top !important;");
      expect(unsafeCSS).toContain("background-repeat: no-repeat !important;");
      expect(unsafeCSS).toContain("background-size: 4px 100% !important;");
      expect(unsafeCSS).toContain(`[data-column-number="2"]:hover {`);
      expect(unsafeCSS).toContain("background-size: 6px 100% !important;");
      expect(unsafeCSS).not.toContain("::before");
      expect(unsafeCSS).not.toContain("pointer-events: auto");
      expect(unsafeCSS).not.toContain(`[data-line]:has([data-column-number="2"])`);

      // Tapping the code content of a changed line must not toggle the inline diff;
      // only the line-number gutter badge does.
      tapElement(document.querySelector('[data-line="2"] code'));
      expect(document.querySelector("[data-testid='workspace-file-render-annotation']")).toBeNull();

      tapElement(document.querySelector('[data-column-number="1"]'));
      expect(document.querySelector("[data-testid='workspace-file-render-annotation']")).toBeNull();

      tapElement(document.querySelector('[data-column-number="2"]'));
      await vi.waitFor(() => {
        expect(
          document.querySelectorAll("[data-testid='workspace-file-render-annotation']"),
        ).toHaveLength(1);
        expect(document.querySelector("[data-testid='workspace-inline-file-diff']")).not.toBeNull();
      });
      const inlineDiffElement = document.querySelector<HTMLElement>(
        "[data-testid='workspace-file-inline-diff']",
      );
      expect(inlineDiffElement?.querySelector(".max-h-\\[min\\(28rem\\,45vh\\)\\]")).not.toBeNull();
      expect(inlineDiffElement?.querySelector(".overflow-y-auto")).not.toBeNull();
      expect(inlineDiffElement?.textContent).toContain("Working tree change 1 of 1");
      expect(
        inlineDiffElement?.querySelector('button[aria-label="Close inline diff"]'),
      ).not.toBeNull();

      tapElement(document.querySelector('[data-column-number="2"]'));
      await vi.waitFor(() => {
        expect(
          document.querySelector("[data-testid='workspace-file-render-annotation']"),
        ).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders deleted-only markers as vertical clickable line-number backgrounds", async () => {
    getWorkingTreeDiffMock.mockResolvedValue({ diff: DELETED_ONLY_FILE_DIFF });
    setGitStatusMock([{ deletions: 1, insertions: 0, path: "src/deleted.ts" }]);

    const mounted = await renderPreview({
      contents: "line one\nline three\n",
      relativePath: "src/deleted.ts",
    });
    try {
      await waitForMarkerCss(2);
      const unsafeCSS = latestFileUnsafeCss();
      expect(unsafeCSS).toContain(
        "background-image: linear-gradient(var(--destructive), var(--destructive)) !important;",
      );
      expect(unsafeCSS).toContain("background-position: left top !important;");
      expect(unsafeCSS).toContain("background-repeat: no-repeat !important;");
      expect(unsafeCSS).toContain("background-size: 4px 100% !important;");
      expect(unsafeCSS).toContain(`[data-column-number="2"]:hover {`);
      expect(unsafeCSS).toContain("background-size: 6px 100% !important;");
      expect(unsafeCSS).not.toContain("background-position: 0.4rem top !important;");
      expect(unsafeCSS).not.toContain("background-size: calc(100% - 1rem) 2px !important;");
      expect(unsafeCSS).not.toContain("::before");
      expect(unsafeCSS).not.toContain("pointer-events: auto");

      tapElement(document.querySelector('[data-column-number="2"]'));
      await vi.waitFor(() => {
        expect(
          document.querySelectorAll("[data-testid='workspace-file-render-annotation']"),
        ).toHaveLength(1);
        expect(document.querySelector("[data-testid='workspace-inline-file-diff']")).not.toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("switches the inline diff annotation when clicking another marker", async () => {
    getWorkingTreeDiffMock.mockResolvedValue({ diff: TWO_HUNK_FILE_DIFF });
    setGitStatusMock([{ deletions: 2, insertions: 2, path: "src/multi.ts" }]);

    const mounted = await renderPreview({
      contents: ["new one", "line two", "line three", "line four", "line five", "new six"].join(
        "\n",
      ),
      relativePath: "src/multi.ts",
    });
    try {
      await waitForMarkerCss(1);
      await waitForMarkerCss(6);

      tapElement(document.querySelector('[data-column-number="1"]'));
      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLElement>("[data-testid='workspace-inline-file-diff']")?.dataset
            .cacheKey,
        ).toContain("inline-hunk:0");
      });
      expect(
        document.querySelector<HTMLElement>("[data-testid='workspace-file-inline-diff']")
          ?.textContent,
      ).toContain("Working tree change 1 of 2");

      tapElement(document.querySelector('[data-column-number="6"]'));
      await vi.waitFor(() => {
        expect(
          document.querySelectorAll("[data-testid='workspace-file-render-annotation']"),
        ).toHaveLength(1);
        expect(
          document.querySelector<HTMLElement>("[data-testid='workspace-inline-file-diff']")?.dataset
            .cacheKey,
        ).toContain("inline-hunk:1");
      });
      expect(
        document.querySelector<HTMLElement>("[data-testid='workspace-file-inline-diff']")
          ?.textContent,
      ).toContain("Working tree change 2 of 2");
    } finally {
      await mounted.cleanup();
    }
  });

  it("navigates between hunks from the inline diff header", async () => {
    getWorkingTreeDiffMock.mockResolvedValue({ diff: TWO_HUNK_FILE_DIFF });
    setGitStatusMock([{ deletions: 2, insertions: 2, path: "src/multi.ts" }]);

    const mounted = await renderPreview({
      contents: ["new one", "line two", "line three", "line four", "line five", "new six"].join(
        "\n",
      ),
      relativePath: "src/multi.ts",
    });
    try {
      await waitForMarkerCss(1);
      await waitForMarkerCss(6);

      tapElement(document.querySelector('[data-column-number="1"]'));
      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLElement>("[data-testid='workspace-inline-file-diff']")?.dataset
            .cacheKey,
        ).toContain("inline-hunk:0");
      });
      const prevButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Previous change"]',
      );
      const nextButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Next change"]',
      );
      expect(prevButton?.disabled).toBe(true);
      expect(nextButton?.disabled).toBe(false);

      nextButton?.click();
      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLElement>("[data-testid='workspace-inline-file-diff']")?.dataset
            .cacheKey,
        ).toContain("inline-hunk:1");
        expect(
          document.querySelector<HTMLElement>("[data-testid='workspace-file-inline-diff']")
            ?.textContent,
        ).toContain("Working tree change 2 of 2");
      });
      expect(
        document.querySelector<HTMLButtonElement>('button[aria-label="Previous change"]')?.disabled,
      ).toBe(false);
      expect(
        document.querySelector<HTMLButtonElement>('button[aria-label="Next change"]')?.disabled,
      ).toBe(true);

      document.querySelector<HTMLButtonElement>('button[aria-label="Previous change"]')?.click();
      await vi.waitFor(() => {
        expect(
          document.querySelector<HTMLElement>("[data-testid='workspace-inline-file-diff']")?.dataset
            .cacheKey,
        ).toContain("inline-hunk:0");
        expect(
          document.querySelector<HTMLElement>("[data-testid='workspace-file-inline-diff']")
            ?.textContent,
        ).toContain("Working tree change 1 of 2");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("navigates into and out of deleted-only hunks from the inline diff header", async () => {
    getWorkingTreeDiffMock.mockResolvedValue({ diff: TWO_HUNK_WITH_DELETION_ONLY_DIFF });
    setGitStatusMock([{ deletions: 2, insertions: 1, path: "src/delete-nav.ts" }]);

    const mounted = await renderPreview({
      contents: ["new one", "line two", "line three", "line four", "line five"].join("\n"),
      relativePath: "src/delete-nav.ts",
    });
    try {
      await waitForMarkerCss(1);
      await waitForMarkerCss(5);

      tapElement(document.querySelector('[data-column-number="1"]'));
      await vi.waitFor(() => {
        expect(
          document.querySelectorAll("[data-testid='workspace-file-render-annotation']"),
        ).toHaveLength(1);
        expect(
          document.querySelector<HTMLElement>("[data-testid='workspace-file-inline-diff']")
            ?.textContent,
        ).toContain("Working tree change 1 of 2");
      });

      document.querySelector<HTMLButtonElement>('button[aria-label="Next change"]')?.click();
      await vi.waitFor(() => {
        expect(
          document.querySelectorAll("[data-testid='workspace-file-render-annotation']"),
        ).toHaveLength(1);
        expect(
          document.querySelector<HTMLElement>("[data-testid='workspace-inline-file-diff']")?.dataset
            .cacheKey,
        ).toContain("inline-hunk:1");
        expect(
          document.querySelector<HTMLElement>("[data-testid='workspace-file-inline-diff']")
            ?.textContent,
        ).toContain("Working tree change 2 of 2");
      });

      document.querySelector<HTMLButtonElement>('button[aria-label="Previous change"]')?.click();
      await vi.waitFor(() => {
        expect(
          document.querySelectorAll("[data-testid='workspace-file-render-annotation']"),
        ).toHaveLength(1);
        expect(
          document.querySelector<HTMLElement>("[data-testid='workspace-inline-file-diff']")?.dataset
            .cacheKey,
        ).toContain("inline-hunk:0");
        expect(
          document.querySelector<HTMLElement>("[data-testid='workspace-file-inline-diff']")
            ?.textContent,
        ).toContain("Working tree change 1 of 2");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses plain text rendering for large files while keeping virtualization", async () => {
    const contents = `${"x".repeat(80)}\n`.repeat(4_000);
    const mounted = await renderPreview({
      contents,
      relativePath: "src/large.ts",
      sizeBytes: 300 * 1024,
      truncated: true,
    });
    try {
      const rendered = document.querySelector<HTMLElement>("[data-testid='workspace-file-render']");
      const virtualizer = document.querySelector<HTMLElement>(
        "[data-testid='workspace-file-virtualizer']",
      );
      expect(rendered?.dataset.lang).toBe("text");
      expect(virtualizer).not.toBeNull();
      await expect.element(page.getByText("Preview truncated. File size: 300 KB.")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("selects and scrolls near the requested target line", async () => {
    const contents = Array.from({ length: 160 }, (_, index) => `line ${index + 1}`).join("\n");
    const mounted = await renderPreview({ contents, line: 120, relativePath: "src/lines.ts" });
    try {
      await vi.waitFor(() => {
        expect(virtualizerMounts.length).toBeGreaterThanOrEqual(2);
        const selected = document.querySelector<HTMLElement>('[data-line="120"]');
        const virtualizer = document.querySelector<HTMLElement>(
          "[data-testid='workspace-file-virtualizer']",
        );
        expect(selected?.dataset.selectedLine).toBe("single");
        expect(virtualizer?.scrollTop).toBeGreaterThan(0);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("copies full loaded contents and toggles word wrap", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const mounted = await renderPreview({ contents: DEFAULT_CONTENTS });
    try {
      expect(fileRenderCalls.at(-1)?.options?.overflow).toBe("scroll");

      await page.getByRole("button", { name: "Copy file" }).click();
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(DEFAULT_CONTENTS);
      });

      await page.getByRole("button", { name: "Enable word wrap" }).click();
      await vi.waitFor(() => {
        expect(fileRenderCalls.at(-1)?.options?.overflow).toBe("wrap");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders full file previews read-only", async () => {
    const writeFile = vi.fn(
      async (input: Parameters<EnvironmentApi["projects"]["writeFile"]>[0]) => ({
        relativePath: input.relativePath,
      }),
    );
    const mounted = await renderPreview({ contents: DEFAULT_CONTENTS, writeFile });
    try {
      expect(fileRenderCalls.at(-1)?.contentEditable).toBeUndefined();
      await expect
        .element(page.getByRole("textbox", { name: "Edit src/App.tsx" }))
        .not.toBeInTheDocument();
      expect(writeFile).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("persists the selected word wrap mode between preview mounts", async () => {
    {
      const mounted = await renderPreview({ contents: DEFAULT_CONTENTS });
      try {
        expect(fileRenderCalls.at(-1)?.options?.overflow).toBe("scroll");

        await page.getByRole("button", { name: "Enable word wrap" }).click();
        await vi.waitFor(() => {
          expect(fileRenderCalls.at(-1)?.options?.overflow).toBe("wrap");
        });
      } finally {
        await mounted.cleanup();
      }
    }

    {
      const mounted = await renderPreview({ contents: DEFAULT_CONTENTS });
      try {
        expect(fileRenderCalls.at(-1)?.options?.overflow).toBe("wrap");

        await page.getByRole("button", { name: "Disable word wrap" }).click();
        await vi.waitFor(() => {
          expect(fileRenderCalls.at(-1)?.options?.overflow).toBe("scroll");
        });
      } finally {
        await mounted.cleanup();
      }
    }

    {
      const mounted = await renderPreview({ contents: DEFAULT_CONTENTS });
      try {
        expect(fileRenderCalls.at(-1)?.options?.overflow).toBe("scroll");
      } finally {
        await mounted.cleanup();
      }
    }
  });

  it("calls the back handler when a diff back target is present", async () => {
    const onBack = vi.fn();
    const backTarget = {
      kind: "diff",
      diffTurnId: TurnId.make("turn-1"),
      diffFilePath: "src/App.tsx",
    } satisfies WorkspaceFilePanelHistoryEntry;
    const mounted = await renderPreview({
      backTarget,
      contents: DEFAULT_CONTENTS,
      onBack,
    });
    try {
      await page.getByRole("button", { name: "Back to diff" }).click();
      expect(onBack).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("calls the back handler when an explorer back target is present", async () => {
    const onBack = vi.fn();
    const backTarget = {
      kind: "explorer",
      context: {
        environmentId: ENVIRONMENT_ID,
        cwd: "/repo/project",
      },
    } satisfies WorkspaceFilePanelHistoryEntry;
    const mounted = await renderPreview({
      backTarget,
      contents: DEFAULT_CONTENTS,
      onBack,
    });
    try {
      await page.getByRole("button", { name: "Back to explorer" }).click();
      expect(onBack).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("calls the back handler when a source control back target is present", async () => {
    const onBack = vi.fn();
    const backTarget = {
      kind: "source-control",
    } satisfies WorkspaceFilePanelHistoryEntry;
    const mounted = await renderPreview({
      backTarget,
      contents: DEFAULT_CONTENTS,
      onBack,
    });
    try {
      await page.getByRole("button", { name: "Back to source control" }).click();
      expect(onBack).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("places the return button before the file icon", async () => {
    const onBack = vi.fn();
    const backTarget = {
      kind: "explorer",
      context: {
        environmentId: ENVIRONMENT_ID,
        cwd: "/repo/project",
      },
    } satisfies WorkspaceFilePanelHistoryEntry;
    const mounted = await renderPreview({
      backTarget,
      contents: DEFAULT_CONTENTS,
      onBack,
      onShowExplorer: vi.fn(),
      showExplorerButton: true,
    });
    try {
      const backButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Back to explorer"]',
      );
      const fileIcon = document.querySelector<SVGSVGElement>("svg[data-pierre-icon]");
      expect(backButton).not.toBeNull();
      expect(fileIcon).not.toBeNull();
      expect(
        Boolean(backButton!.compareDocumentPosition(fileIcon!) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).toBe(true);

      await page.getByRole("button", { name: "Back to explorer" }).click();
      expect(onBack).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the file explorer header button when enabled", async () => {
    const onShowExplorer = vi.fn();
    const mounted = await renderPreview({
      contents: DEFAULT_CONTENTS,
      onShowExplorer,
      showExplorerButton: true,
    });
    try {
      await page.getByRole("button", { name: "Show file explorer" }).click();
      expect(onShowExplorer).toHaveBeenCalledOnce();
    } finally {
      await mounted.cleanup();
    }
  });

  it("adds the current preview file to the input from the header", async () => {
    const onAddFileToInput = vi.fn();
    const mounted = await renderPreview({
      contents: DEFAULT_CONTENTS,
      onAddFileToInput,
    });
    try {
      await page.getByRole("button", { name: "Add src/App.tsx to chat input" }).click();
      expect(onAddFileToInput).toHaveBeenCalledWith("src/App.tsx");
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders image files through the workspace image route without reading them as text", async () => {
    const onAddFileToInput = vi.fn();
    setGitStatusMock([{ path: "assets/chart.png", status: "modified" }]);
    const mounted = await renderImagePreview({
      onAddFileToInput,
      relativePath: "assets/chart.png",
    });
    try {
      const image = document.querySelector<HTMLImageElement>(
        'img[src^="http://environment.test/api/workspace-image"]',
      );
      expect(image?.alt).toBe("assets/chart.png preview");
      expect(image?.src).toBe(
        "http://environment.test/api/workspace-image?cwd=%2Frepo%2Fproject&relativePath=assets%2Fchart.png",
      );
      expect(mounted.readFile).not.toHaveBeenCalled();
      expect(getWorkingTreeDiffMock).not.toHaveBeenCalled();
      expect(resolveEnvironmentHttpUrlMock).toHaveBeenCalledWith({
        environmentId: ENVIRONMENT_ID,
        pathname: "/api/workspace-image",
        searchParams: {
          cwd: "/repo/project",
          relativePath: "assets/chart.png",
        },
      });
      await expect.element(page.getByRole("button", { name: "Copy file" })).not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Enable word wrap" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Disable word wrap" }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Add assets/chart.png to chat input" }).click();
      expect(onAddFileToInput).toHaveBeenCalledWith("assets/chart.png");
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders video files through the workspace video route without reading them as text", async () => {
    const onAddFileToInput = vi.fn();
    setGitStatusMock([{ path: "captures/demo.mp4", status: "modified" }]);
    const mounted = await renderVideoPreview({
      onAddFileToInput,
      relativePath: "captures/demo.mp4",
    });
    try {
      const video = document.querySelector<HTMLVideoElement>(
        'video[src^="http://environment.test/api/workspace-video"]',
      );
      expect(video).not.toBeNull();
      if (!video) {
        throw new Error("Expected workspace video preview to render.");
      }
      expect(video.getAttribute("aria-label")).toBe("captures/demo.mp4 preview");
      expect(video.src).toBe(
        "http://environment.test/api/workspace-video?cwd=%2Frepo%2Fproject&relativePath=captures%2Fdemo.mp4",
      );
      expect(video.controls).toBe(true);
      expect(video.preload).toBe("metadata");
      expect(video.dataset.loadState).toBe("loading");
      expect(video.className).toContain("invisible");
      // Keep Chromium from trying to load the unreachable mocked route before the
      // synthetic metadata event exercises the component's loaded state.
      video.addEventListener("error", (event) => event.stopImmediatePropagation(), {
        capture: true,
      });
      video.removeAttribute("src");
      video.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
      await vi.waitFor(() => {
        expect(video.dataset.loadState).toBe("loaded");
        expect(video.className).not.toContain("invisible");
      });
      expect(mounted.readFile).not.toHaveBeenCalled();
      expect(getWorkingTreeDiffMock).not.toHaveBeenCalled();
      expect(resolveEnvironmentHttpUrlMock).toHaveBeenCalledWith({
        environmentId: ENVIRONMENT_ID,
        pathname: "/api/workspace-video",
        searchParams: {
          cwd: "/repo/project",
          relativePath: "captures/demo.mp4",
        },
      });
      await expect.element(page.getByRole("button", { name: "Copy file" })).not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Enable word wrap" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Disable word wrap" }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Add captures/demo.mp4 to chat input" }).click();
      expect(onAddFileToInput).toHaveBeenCalledWith("captures/demo.mp4");
    } finally {
      await mounted.cleanup();
    }
  });
});
