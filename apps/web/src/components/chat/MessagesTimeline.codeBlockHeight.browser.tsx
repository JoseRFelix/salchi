import "../../index.css";

import {
  EnvironmentId,
  MessageId,
  type EnvironmentId as EnvironmentIdType,
} from "@t3tools/contracts";
import { createRef, forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import type { VirtualizedListHandle } from "../virtualization/VirtualizedList";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const codeHighlightingMock = vi.hoisted(() => {
  let resolveHighlighter: ((value: unknown) => void) | null = null;
  let highlighterPromise = new Promise<unknown>((resolve) => {
    resolveHighlighter = resolve;
  });

  const renderCodeLines = (code: string) =>
    code
      .split("\n")
      .map(
        (line) =>
          `<span class="line"><span style="color:#fbfbfb">${line
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")}</span></span>`,
      )
      .join("\n");

  return {
    createCodeHighlightCacheKey: vi.fn(
      (code: string, language: string, themeName: string, scope: string) =>
        `${scope}:${language}:${themeName}:${code.length}`,
    ),
    getCachedHighlightedCodeHtml: vi.fn(() => null),
    getCodeHighlighterPromise: vi.fn(() => highlighterPromise),
    highlightCodeToHtml: vi.fn(
      ({ code }: { code: string }) =>
        `<pre class="shiki pierre-dark" tabindex="0"><code>${renderCodeLines(code)}</code></pre>`,
    ),
    reset: () => {
      resolveHighlighter = null;
      highlighterPromise = new Promise<unknown>((resolve) => {
        resolveHighlighter = resolve;
      });
    },
    resolve: () => {
      resolveHighlighter?.({});
    },
    resolveCodeHighlightLanguageFromFenceClass: vi.fn((className: string | undefined) => {
      const match = className?.match(/(?:^|\s)language-([^\s]+)/);
      return match?.[1] ?? "text";
    }),
    setCachedHighlightedCodeHtml: vi.fn(),
  };
});

vi.mock("../../codeHighlighting", () => ({
  createCodeHighlightCacheKey: codeHighlightingMock.createCodeHighlightCacheKey,
  getCachedHighlightedCodeHtml: codeHighlightingMock.getCachedHighlightedCodeHtml,
  getCodeHighlighterPromise: codeHighlightingMock.getCodeHighlighterPromise,
  highlightCodeToHtml: codeHighlightingMock.highlightCodeToHtml,
  resolveCodeHighlightLanguageFromFenceClass:
    codeHighlightingMock.resolveCodeHighlightLanguageFromFenceClass,
  setCachedHighlightedCodeHtml: codeHighlightingMock.setCachedHighlightedCodeHtml,
}));

import type { TimelineEntry } from "../../session-logic";
import { MessagesTimeline } from "./MessagesTimeline";

const ACTIVE_THREAD_ENVIRONMENT_ID: EnvironmentIdType = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT_MS = Date.parse("2026-05-19T12:00:00.000Z");
const CODE_BLOCK_INDEX = 35;
const CODE_BLOCK_MESSAGE_ID = MessageId.make(`message-${CODE_BLOCK_INDEX}`);
const TIMELINE_ROW_COUNT = 72;

interface TimelineHarnessHandle {
  readonly anchorTop: () => number | null;
  readonly codeBlockHeight: () => number | null;
  readonly scrollIndexIntoView: (index: number) => Promise<void>;
  readonly scrollTop: () => number;
}

function buildMessageText(role: "assistant" | "user", index: number): string {
  if (index === CODE_BLOCK_INDEX) {
    return [
      "Here is the snippet:",
      "",
      "```ts",
      "const answer = 42;",
      "console.log(answer);",
      "```",
      "",
      "That should stay stable after highlighting.",
    ].join("\n");
  }

  return `${role} message ${index}\n${"body ".repeat(70).trim()}`;
}

function buildTimelineEntry(index: number): Extract<TimelineEntry, { kind: "message" }> {
  const role = index % 2 === 0 ? "user" : "assistant";
  const createdAt = new Date(MESSAGE_CREATED_AT_MS + index * 1_000).toISOString();
  const messageId = MessageId.make(`message-${index}`);
  return {
    id: messageId,
    kind: "message",
    createdAt,
    message: {
      id: messageId,
      role,
      text: buildMessageText(role, index),
      createdAt,
      streaming: false,
    },
  };
}

function buildTimelineEntries(count: number): TimelineEntry[] {
  return Array.from({ length: count }, (_, index) => buildTimelineEntry(index));
}

function getScrollNode(listRef: VirtualizedListHandle | null): HTMLElement {
  const scrollNode = listRef?.getScrollableNode?.();
  if (!scrollNode) {
    throw new Error("Unable to resolve MessagesTimeline scroll node.");
  }
  return scrollNode;
}

async function waitForLayout(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

const TimelineHarness = forwardRef<TimelineHarnessHandle>(function TimelineHarness(_, ref) {
  const timelineEntries = useMemo(() => buildTimelineEntries(TIMELINE_ROW_COUNT), []);
  const listRef = useRef<VirtualizedListHandle | null>(null);
  const emptyRevertTurnCount = useMemo(() => new Map(), []);

  useImperativeHandle(
    ref,
    () => ({
      anchorTop: () => {
        const anchor = document.querySelector<HTMLElement>(
          `[data-timeline-anchor-id="message:${CODE_BLOCK_MESSAGE_ID}"]`,
        );
        return anchor?.getBoundingClientRect().top ?? null;
      },
      codeBlockHeight: () => {
        const codeBlock = document.querySelector<HTMLElement>(".chat-markdown-codeblock");
        return codeBlock?.getBoundingClientRect().height ?? null;
      },
      scrollIndexIntoView: async (index: number) => {
        await listRef.current?.scrollIndexIntoView?.({ index, animated: false });
      },
      scrollTop: () => getScrollNode(listRef.current).scrollTop,
    }),
    [],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "720px", width: "900px" }}>
      <MessagesTimeline
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        listRef={listRef}
        timelineEntries={timelineEntries}
        latestTurn={null}
        activeTurnId={null}
        turnDiffSummaries={[]}
        routeThreadKey="environment-local:thread-code-block-height"
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={emptyRevertTurnCount}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        activeThreadEnvironmentId={ACTIVE_THREAD_ENVIRONMENT_ID}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
        skills={[]}
        onIsAtEndChange={() => {}}
      />
    </div>
  );
});

describe("MessagesTimeline code block height stability", () => {
  afterEach(() => {
    codeHighlightingMock.reset();
    codeHighlightingMock.createCodeHighlightCacheKey.mockClear();
    codeHighlightingMock.getCachedHighlightedCodeHtml.mockClear();
    codeHighlightingMock.getCodeHighlighterPromise.mockClear();
    codeHighlightingMock.highlightCodeToHtml.mockClear();
    codeHighlightingMock.resolveCodeHighlightLanguageFromFenceClass.mockClear();
    codeHighlightingMock.setCachedHighlightedCodeHtml.mockClear();
    document.body.innerHTML = "";
  });

  it("does not yank scroll position when a visible code block resolves highlighting", async () => {
    await page.viewport(1_000, 760);
    const harnessRef = createRef<TimelineHarnessHandle>();
    const screen = await render(<TimelineHarness ref={harnessRef} />);

    try {
      await waitForLayout();
      await harnessRef.current?.scrollIndexIntoView(CODE_BLOCK_INDEX);
      await waitForLayout();

      await vi.waitFor(() => {
        expect(document.querySelector('[data-code-highlight-state="fallback"]')).not.toBeNull();
      });

      const beforeScrollTop = harnessRef.current!.scrollTop();
      const beforeAnchorTop = harnessRef.current!.anchorTop();
      const fallbackHeight = harnessRef.current!.codeBlockHeight();
      expect(beforeAnchorTop).not.toBeNull();
      expect(fallbackHeight).not.toBeNull();

      codeHighlightingMock.resolve();

      await vi.waitFor(() => {
        expect(document.querySelector('[data-code-highlight-state="highlighted"]')).not.toBeNull();
      });
      await waitForLayout();

      const afterScrollTop = harnessRef.current!.scrollTop();
      const afterAnchorTop = harnessRef.current!.anchorTop();
      const highlightedHeight = harnessRef.current!.codeBlockHeight();

      expect(afterAnchorTop).not.toBeNull();
      expect(highlightedHeight).not.toBeNull();
      expect(Math.abs(afterScrollTop - beforeScrollTop)).toBeLessThan(4);
      expect(Math.abs((afterAnchorTop ?? 0) - (beforeAnchorTop ?? 0))).toBeLessThan(4);
      expect(Math.abs((highlightedHeight ?? 0) - (fallbackHeight ?? 0))).toBeLessThanOrEqual(1);
    } finally {
      await screen.unmount();
    }
  });
});
