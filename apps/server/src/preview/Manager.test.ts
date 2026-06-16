import { it } from "@effect/vitest";
import { type PreviewEvent, ThreadId } from "@t3tools/contracts";
import { Effect, Layer, PubSub } from "effect";
import { expect } from "vite-plus/test";

import * as PreviewManager from "./Manager.ts";
import * as SteelBrowser from "./SteelBrowser.ts";

const DRAIN_LIMIT = 100;

interface EventCollector {
  /** Drain everything published since the last call (or since subscribe). */
  readonly drain: Effect.Effect<ReadonlyArray<PreviewEvent>>;
}

/**
 * Each `it.effect` shares the live PreviewManager layer across the whole
 * `it.layer` block, so tests that assert per-thread counts must use a unique
 * thread id to avoid bleeding state from earlier tests.
 */
let nextThreadId = 0;
const freshThreadId = () => ThreadId.make(`thread-${++nextThreadId}`);

/**
 * Subscribe to the manager's event stream BEFORE the test publishes. We
 * use `subscribeEvents` (synchronous PubSub.subscribe under the hood) so
 * no event can land between subscribe and the consumer drain.
 */
const collectEvents = Effect.gen(function* () {
  const manager = yield* PreviewManager.PreviewManager;
  const subscription = yield* manager.subscribeEvents;
  const collector: EventCollector = {
    drain: PubSub.takeUpTo(subscription, DRAIN_LIMIT),
  };
  return collector;
}).pipe(Effect.withSpan("preview.test.collectEvents"));

const previewManagerWithDisabledSteelLayer = PreviewManager.layer.pipe(
  Layer.provide(SteelBrowser.layerDisabled),
);

it.layer(previewManagerWithDisabledSteelLayer)("PreviewManager", (it) => {
  it.effect("opens a session and emits opened with normalized URL", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const snapshot = yield* manager.open({ threadId, url: "localhost:5173" });
      expect(snapshot.tabId.startsWith("tab_")).toBe(true);
      expect(snapshot.navStatus._tag).toBe("Loading");
      if (snapshot.navStatus._tag === "Loading") {
        expect(snapshot.navStatus.url).toBe("http://localhost:5173/");
      }

      const events = yield* collector.drain;
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("opened");
      if (events[0]?.type === "opened") {
        expect(events[0].tabId).toBe(snapshot.tabId);
      }
    }),
  );

  it.effect("opens an Idle tab when no URL is supplied", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const snapshot = yield* manager.open({ threadId });
      expect(snapshot.navStatus._tag).toBe("Idle");
    }),
  );

  it.effect("treats bare hosts as https", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const snapshot = yield* manager.open({ threadId, url: "example.com" });
      if (snapshot.navStatus._tag === "Loading") {
        expect(snapshot.navStatus.url).toBe("https://example.com/");
      }
    }),
  );

  it.effect("rejects empty URL with PreviewInvalidUrlError", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const error = yield* Effect.flip(manager.open({ threadId, url: "   " }));
      expect(error._tag).toBe("PreviewInvalidUrlError");
    }),
  );

  it.effect("navigate updates snapshot and emits navigated", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const snapshot = yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/about",
        resolvedTitle: "About",
      });

      expect(snapshot.navStatus._tag).toBe("Success");
      if (snapshot.navStatus._tag === "Success") {
        expect(snapshot.navStatus.url).toBe("http://localhost:5173/about");
        expect(snapshot.navStatus.title).toBe("About");
      }
      const events = yield* collector.drain;
      expect(events.map((e) => e.type)).toEqual(["opened", "navigated"]);
    }),
  );

  it.effect("navigate fails for unknown tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const error = yield* Effect.flip(
        manager.navigate({
          threadId,
          tabId: "tab_missing",
          url: "http://localhost:5173",
        }),
      );
      expect(error._tag).toBe("PreviewSessionLookupError");
    }),
  );

  it.effect("reportStatus emits failed for LoadFailed nav", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: {
          _tag: "LoadFailed",
          url: "http://localhost:5173",
          title: "",
          code: -105,
          description: "ERR_NAME_NOT_RESOLVED",
        },
        canGoBack: false,
        canGoForward: false,
      });

      const events = yield* collector.drain;
      const failed = events.find((e) => e.type === "failed");
      expect(failed?.type).toBe("failed");
      if (failed?.type === "failed") {
        expect(failed.code).toBe(-105);
        expect(failed.description).toBe("ERR_NAME_NOT_RESOLVED");
      }
    }),
  );

  it.effect("close removes the session and emits closed", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.close({ threadId });

      const result = yield* manager.list({ threadId });
      expect(result.sessions).toHaveLength(0);
      const events = yield* collector.drain;
      const closed = events.find((e) => e.type === "closed");
      expect(closed?.type).toBe("closed");
    }),
  );

  it.effect("close is idempotent for unknown threads", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.close({ threadId });
      const result = yield* manager.list({ threadId });
      expect(result.sessions).toHaveLength(0);
    }),
  );

  it.effect("list returns every snapshot for the thread sorted by updatedAt", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const first = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const second = yield* manager.open({ threadId, url: "http://localhost:3000" });
      const result = yield* manager.list({ threadId });
      expect(result.sessions).toHaveLength(2);
      const ids = result.sessions.map((s) => s.tabId);
      expect(ids).toContain(first.tabId);
      expect(ids).toContain(second.tabId);
    }),
  );

  it.effect("open creates an independent tab on every call", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const a = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const b = yield* manager.open({ threadId, url: "http://localhost:3000/path" });

      expect(a.tabId).not.toBe(b.tabId);
      const list = yield* manager.list({ threadId });
      expect(list.sessions).toHaveLength(2);

      const events = yield* collector.drain;
      expect(events.map((e) => e.type)).toEqual(["opened", "opened"]);
    }),
  );

  it.effect("close with mismatching tabId is a no-op", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.close({ threadId, tabId: "tab_missing" });

      const list = yield* manager.list({ threadId });
      expect(list.sessions).toHaveLength(1);
    }),
  );

  it.effect("close with explicit tabId removes only that tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const a = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const b = yield* manager.open({ threadId, url: "http://localhost:3000" });

      yield* manager.close({ threadId, tabId: a.tabId });

      const list = yield* manager.list({ threadId });
      expect(list.sessions.map((s) => s.tabId)).toEqual([b.tabId]);
    }),
  );

  it.effect("multiple subscribers receive every event independently", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const aSub = yield* manager.subscribeEvents;
      const bSub = yield* manager.subscribeEvents;

      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.open({ threadId, url: "http://localhost:3000" });

      const aEvents = yield* PubSub.takeUpTo(aSub, DRAIN_LIMIT);
      const bEvents = yield* PubSub.takeUpTo(bSub, DRAIN_LIMIT);
      expect(aEvents.map((e) => e.type)).toEqual(["opened", "opened"]);
      expect(bEvents.map((e) => e.type)).toEqual(["opened", "opened"]);
    }),
  );
});

interface SteelBrowserCalls {
  readonly sessions: Array<{
    readonly sessionId: string;
    readonly viewportSize?: { readonly width: number; readonly height: number } | undefined;
  }>;
  readonly navigations: Array<{
    readonly sessionId: string;
    readonly url: string;
    readonly viewportSize?: { readonly width: number; readonly height: number } | undefined;
  }>;
  readonly reloads: Array<{
    readonly sessionId: string;
    readonly viewportSize?: { readonly width: number; readonly height: number } | undefined;
  }>;
  readonly backs: string[];
  readonly forwards: string[];
  readonly keyboardInputs: Array<{
    readonly sessionId: string;
    readonly action: SteelBrowser.SteelBrowserKeyboardAction;
  }>;
  readonly releases: string[];
}

const steelCalls: SteelBrowserCalls = {
  sessions: [],
  navigations: [],
  reloads: [],
  backs: [],
  forwards: [],
  keyboardInputs: [],
  releases: [],
};

const resetSteelCalls = () => {
  steelCalls.sessions.length = 0;
  steelCalls.navigations.length = 0;
  steelCalls.reloads.length = 0;
  steelCalls.backs.length = 0;
  steelCalls.forwards.length = 0;
  steelCalls.keyboardInputs.length = 0;
  steelCalls.releases.length = 0;
};

const fakeSteelLayer = Layer.succeed(SteelBrowser.SteelBrowser, {
  enabled: true,
  createMobileSession: (input) =>
    Effect.sync(() => {
      const sessionId = `steel-session-${steelCalls.sessions.length + 1}`;
      steelCalls.sessions.push({ sessionId, viewportSize: input?.viewportSize });
      return {
        sessionId,
        websocketUrl: `ws://steel.local/${sessionId}`,
        viewerUrl: `http://steel.local/v1/sessions/debug?session=${sessionId}`,
      };
    }),
  navigate: (input) =>
    Effect.sync(() => {
      steelCalls.navigations.push({
        sessionId: input.sessionId,
        url: input.url,
        viewportSize: input.viewportSize,
      });
      return {
        url: input.url,
        title: "",
        canGoBack: steelCalls.navigations.length > 1,
        canGoForward: false,
      };
    }),
  reload: (input) =>
    Effect.sync(() => {
      steelCalls.reloads.push({
        sessionId: input.sessionId,
        viewportSize: input.viewportSize,
      });
      return {
        url: "http://localhost:5173/",
        title: "",
        canGoBack: false,
        canGoForward: false,
      };
    }),
  goBack: (input) =>
    Effect.sync(() => {
      steelCalls.backs.push(input.sessionId);
      return {
        url: "http://localhost:5173/",
        title: "",
        canGoBack: false,
        canGoForward: true,
      };
    }),
  goForward: (input) =>
    Effect.sync(() => {
      steelCalls.forwards.push(input.sessionId);
      return {
        url: "http://localhost:5173/about",
        title: "",
        canGoBack: true,
        canGoForward: false,
      };
    }),
  keyboardInput: (input) =>
    Effect.sync(() => {
      steelCalls.keyboardInputs.push({ sessionId: input.sessionId, action: input.action });
    }),
  release: (input) =>
    Effect.sync(() => {
      steelCalls.releases.push(input.sessionId);
    }),
} satisfies SteelBrowser.SteelBrowserShape);

it.layer(PreviewManager.layer.pipe(Layer.provide(fakeSteelLayer)))(
  "PreviewManager Steel host",
  (it) => {
    it.effect("opens a Steel mobile session and exposes its viewer host", () =>
      Effect.gen(function* () {
        resetSteelCalls();
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;

        const snapshot = yield* manager.open({
          threadId,
          url: "localhost:5173",
          hostPreference: "steel",
          viewportSize: { width: 508, height: 974 },
        });

        expect(snapshot.host?._tag).toBe("Steel");
        if (snapshot.host?._tag === "Steel") {
          expect(snapshot.host.sessionId).toBe("steel-session-1");
          expect(snapshot.host.viewerUrl).toContain("/v1/sessions/debug");
          expect(snapshot.host.viewportSize).toEqual({ width: 508, height: 974 });
        }
        expect(snapshot.navStatus._tag).toBe("Success");
        expect(steelCalls.navigations).toEqual([
          {
            sessionId: "steel-session-1",
            url: "http://localhost:5173/",
            viewportSize: { width: 508, height: 974 },
          },
        ]);
        expect(steelCalls.sessions).toEqual([
          { sessionId: "steel-session-1", viewportSize: { width: 508, height: 974 } },
        ]);
      }),
    );

    it.effect("navigates and releases Steel sessions", () =>
      Effect.gen(function* () {
        resetSteelCalls();
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const opened = yield* manager.open({
          threadId,
          url: "http://localhost:5173",
          hostPreference: "steel",
        });

        yield* manager.navigate({
          threadId,
          tabId: opened.tabId,
          url: "http://localhost:5173/about",
          viewportSize: { width: 508, height: 974 },
        });
        yield* manager.close({ threadId, tabId: opened.tabId });

        expect(steelCalls.navigations).toEqual([
          { sessionId: "steel-session-1", url: "http://localhost:5173/", viewportSize: undefined },
          {
            sessionId: "steel-session-2",
            url: "http://localhost:5173/about",
            viewportSize: { width: 508, height: 974 },
          },
        ]);
        expect(steelCalls.releases).toEqual(["steel-session-1", "steel-session-2"]);
      }),
    );

    it.effect("recreates Steel session when viewport size changes", () =>
      Effect.gen(function* () {
        resetSteelCalls();
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const opened = yield* manager.open({
          threadId,
          url: "http://localhost:5173",
          hostPreference: "steel",
        });

        const resized = yield* manager.navigate({
          threadId,
          tabId: opened.tabId,
          url: "http://localhost:5173",
          viewportSize: { width: 508, height: 900 },
        });

        expect(resized.tabId).toBe(opened.tabId);
        expect(resized.host?._tag).toBe("Steel");
        if (resized.host?._tag === "Steel") {
          expect(resized.host.sessionId).toBe("steel-session-2");
          expect(resized.host.viewportSize).toEqual({ width: 508, height: 900 });
        }
        expect(steelCalls.sessions).toEqual([
          { sessionId: "steel-session-1", viewportSize: undefined },
          { sessionId: "steel-session-2", viewportSize: { width: 508, height: 900 } },
        ]);
        expect(steelCalls.navigations).toEqual([
          { sessionId: "steel-session-1", url: "http://localhost:5173/" },
          {
            sessionId: "steel-session-2",
            url: "http://localhost:5173/",
            viewportSize: { width: 508, height: 900 },
          },
        ]);
        expect(steelCalls.releases).toEqual(["steel-session-1"]);
      }),
    );

    it.effect("drives Steel history controls and updates history availability", () =>
      Effect.gen(function* () {
        resetSteelCalls();
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const opened = yield* manager.open({
          threadId,
          url: "http://localhost:5173",
          hostPreference: "steel",
        });
        const navigated = yield* manager.navigate({
          threadId,
          tabId: opened.tabId,
          url: "http://localhost:5173/about",
        });

        expect(navigated.canGoBack).toBe(true);

        const back = yield* manager.goBack({ threadId, tabId: opened.tabId });
        expect(back.navStatus).toEqual({
          _tag: "Success",
          url: "http://localhost:5173/",
          title: "",
        });
        expect(back.canGoBack).toBe(false);
        expect(back.canGoForward).toBe(true);

        const forward = yield* manager.goForward({ threadId, tabId: opened.tabId });
        expect(forward.navStatus).toEqual({
          _tag: "Success",
          url: "http://localhost:5173/about",
          title: "",
        });
        expect(forward.canGoBack).toBe(true);
        expect(forward.canGoForward).toBe(false);
        expect(steelCalls.backs).toEqual(["steel-session-1"]);
        expect(steelCalls.forwards).toEqual(["steel-session-1"]);
      }),
    );

    it.effect("reloads and sends keyboard input to Steel sessions", () =>
      Effect.gen(function* () {
        resetSteelCalls();
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const opened = yield* manager.open({
          threadId,
          url: "http://localhost:5173",
          hostPreference: "steel",
        });

        yield* manager.refresh({ threadId, tabId: opened.tabId });
        yield* manager.keyboardInput({
          threadId,
          tabId: opened.tabId,
          action: { _tag: "InsertText", text: "hello" },
        });
        yield* manager.keyboardInput({
          threadId,
          tabId: opened.tabId,
          action: { _tag: "PressKey", key: "Backspace" },
        });

        expect(steelCalls.reloads).toEqual([
          { sessionId: "steel-session-1", viewportSize: undefined },
        ]);
        expect(steelCalls.keyboardInputs).toEqual([
          { sessionId: "steel-session-1", action: { _tag: "InsertText", text: "hello" } },
          { sessionId: "steel-session-1", action: { _tag: "PressKey", key: "Backspace" } },
        ]);
      }),
    );
  },
);

it.layer(previewManagerWithDisabledSteelLayer)("PreviewManager disabled Steel host", (it) => {
  it.effect("fails with PreviewRemoteHostUnavailableError when Steel is not configured", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;

      const error = yield* Effect.flip(
        manager.open({
          threadId,
          hostPreference: "steel",
        }),
      );

      expect(error._tag).toBe("PreviewRemoteHostUnavailableError");
    }),
  );
});
