"use client";

import { scopedThreadKey } from "@t3tools/client-runtime";
import {
  type PreviewKeyboardInput,
  type PreviewOpenInput,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  type ClipboardEvent,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { ensureEnvironmentApi } from "~/environmentApi";
import { previewAnnotationScreenshotFile } from "~/lib/previewAnnotation";
import { cn } from "~/lib/utils";
import { ensureLocalApi } from "~/localApi";
import { selectThreadPreviewState, usePreviewStateStore } from "~/previewStateStore";
import { useServerConfig } from "~/rpc/serverState";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { readEnvironmentConnection } from "~/environments/runtime";

import { previewBridge } from "./previewBridge";
import { subscribePreviewAction } from "./previewActionBus";
import { openPreviewSession } from "./openPreviewSession";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { formatPreviewUrl } from "./previewUrlPresentation";
import { PreviewEmptyState } from "./PreviewEmptyState";
import { PreviewMoreMenu } from "./PreviewMoreMenu";
import { PreviewUnreachable } from "./PreviewUnreachable";
import { revealInFileExplorerLabel } from "./fileExplorerLabel";
import { shouldShowPreviewEmptyState } from "./previewEmptyStateLogic";
import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { useLoadingProgress } from "./useLoadingProgress";
import { usePreviewSession } from "./usePreviewSession";
import { ZoomIndicator } from "./ZoomIndicator";
import { AgentBrowserCursor } from "./AgentBrowserCursor";
import {
  startBrowserRecording,
  stopBrowserRecording,
  useBrowserRecordingStore,
} from "~/browser/browserRecording";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";

interface Props {
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
}

interface PendingSteelPreview {
  readonly url: string;
  readonly viewerUrl: string;
  readonly loading: boolean;
}

// Steel clamps every mobile session up to these minimums independently
// (`width = max(w, 508)`, `height = max(h, 1074)` in its session.service). If we
// send a viewport that violates either minimum, Steel grows only that dimension and
// breaks our aspect ratio — which the viewer then pillarboxes (empty side bands)
// because it centers the screencast canvas with `height:100%; width:auto`.
const STEEL_MOBILE_MIN_WIDTH = 508;
const STEEL_MOBILE_MIN_HEIGHT = 1074;
const STEEL_MOBILE_MIN_ASPECT = STEEL_MOBILE_MIN_WIDTH / STEEL_MOBILE_MIN_HEIGHT;

const localApi = typeof window === "undefined" ? null : ensureLocalApi();

function resolveSteelViewportSize(rect: DOMRectReadOnly): PreviewOpenInput["viewportSize"] {
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  // Match the preview container's aspect ratio while keeping both dimensions at or
  // above Steel's mobile minimums, so its clamp is a no-op and the page fills the
  // preview with no left/right (or top/bottom) bands. Anchor on whichever minimum
  // keeps the other dimension above its own minimum.
  const aspect = rect.width / rect.height;
  if (aspect >= STEEL_MOBILE_MIN_ASPECT) {
    // Container is wider than the minimum device: pin height, widen to match.
    return { width: Math.round(STEEL_MOBILE_MIN_HEIGHT * aspect), height: STEEL_MOBILE_MIN_HEIGHT };
  }
  // Container is taller/narrower: pin width, lengthen to match.
  return { width: STEEL_MOBILE_MIN_WIDTH, height: Math.round(STEEL_MOBILE_MIN_WIDTH / aspect) };
}

function previewViewportSizesEqual(
  left: PreviewOpenInput["viewportSize"] | undefined,
  right: PreviewOpenInput["viewportSize"] | undefined,
): boolean {
  return left?.width === right?.width && left?.height === right?.height;
}

function previewNavigationErrorDescription(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return "The preview browser did not accept the navigation request.";
}

/**
 * Single-tab preview surface: chrome row on top, one webview below, empty
 * state when no session exists for the thread.
 */
export function PreviewView({ threadRef, tabId: requestedTabId, configuredUrls, visible }: Props) {
  const [focusUrlNonce, setFocusUrlNonce] = useState<number | undefined>(undefined);
  const [pickActive, setPickActive] = useState(false);
  const [keyboardInputActive, setKeyboardInputActive] = useState(false);
  const [pendingSteelPreview, setPendingSteelPreview] = useState<PendingSteelPreview | null>(null);
  const [steelViewportSize, setSteelViewportSize] = useState<PreviewOpenInput["viewportSize"]>();
  const activeRecordingTabId = useBrowserRecordingStore((state) => state.activeTabId);
  const pickActiveRef = useRef(false);
  const isMountedRef = useRef(true);
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  const keyboardProxyRef = useRef<HTMLTextAreaElement | null>(null);
  const keyboardComposingRef = useRef(false);
  const keyboardInputErrorShownRef = useRef(false);
  const steelResizeRequestRef = useRef<string | null>(null);
  const previewState = usePreviewStateStore((state) =>
    selectThreadPreviewState(state.byThreadKey, threadRef),
  );
  const applyServerSnapshot = usePreviewStateStore((state) => state.applyServerSnapshot);
  const rememberUrl = usePreviewStateStore((state) => state.rememberUrl);
  const addPreviewAnnotation = useComposerDraftStore((store) => store.addPreviewAnnotation);
  const addImage = useComposerDraftStore((store) => store.addImage);
  const serverConfig = useServerConfig();

  usePreviewSession(threadRef);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const element = previewBodyRef.current;
    if (!element) return;

    const updateViewportSize = () => {
      const next = resolveSteelViewportSize(element.getBoundingClientRect());
      if (next === undefined) return;
      setSteelViewportSize((current) =>
        current?.width === next.width && current.height === next.height ? current : next,
      );
    };

    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(element);
    window.addEventListener("resize", updateViewportSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateViewportSize);
    };
  }, []);

  const tabId = requestedTabId ?? previewState.activeTabId;
  const snapshot = tabId ? (previewState.sessions[tabId] ?? null) : null;
  const steelHost = snapshot?.host?._tag === "Steel" ? snapshot.host : null;
  const canUseDesktopBridge = Boolean(previewBridge) && steelHost === null;
  const steelPreviewEnabled = serverConfig?.preview?.steel.enabled === true;
  const steelFallbackViewerUrl = serverConfig?.preview?.steel.viewerUrl ?? null;
  const desktopOverlay = tabId ? (previewState.desktopByTabId[tabId] ?? null) : null;
  const navStatus = snapshot?.navStatus ?? { _tag: "Idle" as const };
  const url = navStatus._tag === "Idle" ? "" : navStatus.url;
  const showEmptyState = shouldShowPreviewEmptyState(snapshot);
  const showPendingSteelPreview =
    pendingSteelPreview !== null && steelHost === null && (snapshot === null || showEmptyState);
  const chromeUrl = url || pendingSteelPreview?.url || "";
  const loading = showPendingSteelPreview
    ? pendingSteelPreview.loading
    : steelHost
      ? navStatus._tag === "Loading"
      : (desktopOverlay?.loading ?? navStatus._tag === "Loading");
  const canUseServerPreviewControls =
    !canUseDesktopBridge && tabId !== null && chromeUrl.length > 0;
  const canGoBack = canUseServerPreviewControls
    ? true
    : (desktopOverlay?.canGoBack ?? snapshot?.canGoBack ?? false);
  const canGoForward = canUseServerPreviewControls
    ? true
    : (desktopOverlay?.canGoForward ?? snapshot?.canGoForward ?? false);
  const refreshDisabled =
    tabId === null || (navStatus._tag === "Idle" && pendingSteelPreview === null);
  const isUnreachable = navStatus._tag === "LoadFailed";
  const controller = steelHost ? "none" : (desktopOverlay?.controller ?? "none");
  const loadProgress = useLoadingProgress(loading);
  const environmentConnection = readEnvironmentConnection(threadRef.environmentId);
  const displayUrl =
    chromeUrl && environmentConnection
      ? (formatPreviewUrl({
          url: chromeUrl,
          environmentLabel: environmentConnection.knownEnvironment.label,
          environmentHttpBaseUrl: environmentConnection.knownEnvironment.target.httpBaseUrl,
        }) ?? undefined)
      : undefined;

  useEffect(() => {
    if (pendingSteelPreview === null) return;
    if (steelHost !== null || (snapshot !== null && !showEmptyState)) {
      setPendingSteelPreview(null);
    }
  }, [pendingSteelPreview, showEmptyState, snapshot, steelHost]);

  useEffect(() => {
    if (steelHost !== null) return;
    setKeyboardInputActive(false);
    keyboardProxyRef.current?.blur();
  }, [steelHost]);

  useEffect(() => {
    if (
      steelHost === null ||
      steelViewportSize === undefined ||
      tabId === null ||
      navStatus._tag === "Idle" ||
      previewViewportSizesEqual(steelHost.viewportSize, steelViewportSize)
    ) {
      return;
    }

    const requestKey = `${tabId}:${navStatus.url}:${steelViewportSize.width}x${steelViewportSize.height}`;
    if (steelResizeRequestRef.current === requestKey) return;
    steelResizeRequestRef.current = requestKey;

    let cancelled = false;
    const api = ensureEnvironmentApi(threadRef.environmentId);
    void api.preview
      .navigate({
        threadId: threadRef.threadId,
        tabId,
        url: navStatus.url,
        viewportSize: steelViewportSize,
      })
      .then((nextSnapshot) => {
        if (cancelled) return;
        applyServerSnapshot(threadRef, nextSnapshot);
      })
      .catch(() => {
        if (steelResizeRequestRef.current === requestKey) {
          steelResizeRequestRef.current = null;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applyServerSnapshot, navStatus, steelHost, steelViewportSize, tabId, threadRef]);

  const handleSubmitUrl = useCallback(
    async (next: string): Promise<boolean> => {
      const api = ensureEnvironmentApi(threadRef.environmentId);
      try {
        const resolvedUrl = resolveDiscoveredServerUrl(threadRef.environmentId, next);
        const currentSteelViewportSize =
          previewBodyRef.current !== null
            ? (resolveSteelViewportSize(previewBodyRef.current.getBoundingClientRect()) ??
              steelViewportSize)
            : steelViewportSize;
        if (tabId && canUseDesktopBridge && previewBridge) {
          // Drive the webview imperatively; `usePreviewBridge` mirrors the
          // resolved URL back to the server so other clients stay in sync.
          await previewBridge.navigate(tabId, resolvedUrl);
          rememberUrl(threadRef, resolvedUrl);
        } else if (tabId && steelHost) {
          const snapshot = await api.preview.navigate({
            threadId: threadRef.threadId,
            tabId,
            url: resolvedUrl,
            ...(currentSteelViewportSize !== undefined
              ? { viewportSize: currentSteelViewportSize }
              : {}),
          });
          applyServerSnapshot(threadRef, snapshot);
          rememberUrl(threadRef, resolvedUrl);
        } else {
          if (!previewBridge && steelPreviewEnabled && steelFallbackViewerUrl) {
            setPendingSteelPreview({
              url: resolvedUrl,
              viewerUrl: steelFallbackViewerUrl,
              loading: true,
            });
          }
          await openPreviewSession({
            previewApi: api.preview,
            threadRef,
            url: resolvedUrl,
            ...(previewBridge
              ? { hostPreference: "desktop" as const }
              : steelPreviewEnabled
                ? {
                    hostPreference: "steel" as const,
                    ...(currentSteelViewportSize !== undefined
                      ? { viewportSize: currentSteelViewportSize }
                      : {}),
                  }
                : {}),
            applyServerSnapshot,
            rememberUrl,
          });
        }
        return true;
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open preview",
            description: previewNavigationErrorDescription(error),
          }),
        );
        return false;
      }
    },
    [
      applyServerSnapshot,
      canUseDesktopBridge,
      rememberUrl,
      steelHost,
      steelFallbackViewerUrl,
      steelPreviewEnabled,
      steelViewportSize,
      tabId,
      threadRef,
    ],
  );

  const handleRefresh = useCallback(() => {
    if (canUseDesktopBridge && previewBridge && tabId) {
      void previewBridge.refresh(tabId);
      return;
    }
    if (!canUseDesktopBridge && tabId) {
      const api = ensureEnvironmentApi(threadRef.environmentId);
      void api.preview.refresh({ threadId: threadRef.threadId, tabId }).catch(() => undefined);
    }
  }, [canUseDesktopBridge, tabId, threadRef.environmentId, threadRef.threadId]);

  const handleZoomIn = useCallback(() => {
    if (canUseDesktopBridge && previewBridge && tabId) void previewBridge.zoomIn(tabId);
  }, [canUseDesktopBridge, tabId]);

  const handleZoomOut = useCallback(() => {
    if (canUseDesktopBridge && previewBridge && tabId) void previewBridge.zoomOut(tabId);
  }, [canUseDesktopBridge, tabId]);

  const handleResetZoom = useCallback(() => {
    if (canUseDesktopBridge && previewBridge && tabId) void previewBridge.resetZoom(tabId);
  }, [canUseDesktopBridge, tabId]);

  const handleBack = useCallback(() => {
    if (canUseDesktopBridge && previewBridge && tabId) {
      void previewBridge.goBack(tabId);
      return;
    }
    if (!canUseDesktopBridge && tabId) {
      const api = ensureEnvironmentApi(threadRef.environmentId);
      void api.preview
        .goBack({ threadId: threadRef.threadId, tabId })
        .then((snapshot) => applyServerSnapshot(threadRef, snapshot))
        .catch(() => undefined);
    }
  }, [applyServerSnapshot, canUseDesktopBridge, tabId, threadRef]);

  const handleForward = useCallback(() => {
    if (canUseDesktopBridge && previewBridge && tabId) {
      void previewBridge.goForward(tabId);
      return;
    }
    if (!canUseDesktopBridge && tabId) {
      const api = ensureEnvironmentApi(threadRef.environmentId);
      void api.preview
        .goForward({ threadId: threadRef.threadId, tabId })
        .then((snapshot) => applyServerSnapshot(threadRef, snapshot))
        .catch(() => undefined);
    }
  }, [applyServerSnapshot, canUseDesktopBridge, tabId, threadRef]);

  const sendSteelKeyboardInput = useCallback(
    (action: PreviewKeyboardInput["action"]) => {
      if (!steelHost || !tabId) return;
      if (action._tag === "InsertText" && action.text.length === 0) return;
      const api = ensureEnvironmentApi(threadRef.environmentId);
      void api.preview
        .keyboardInput({ threadId: threadRef.threadId, tabId, action })
        .catch((error) => {
          if (keyboardInputErrorShownRef.current) return;
          keyboardInputErrorShownRef.current = true;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to send keyboard input",
              description: previewNavigationErrorDescription(error),
            }),
          );
        });
    },
    [steelHost, tabId, threadRef],
  );

  const handleKeyboardInputToggle = useCallback(() => {
    const node = keyboardProxyRef.current;
    if (keyboardInputActive) {
      setKeyboardInputActive(false);
      node?.blur();
      return;
    }
    keyboardInputErrorShownRef.current = false;
    setKeyboardInputActive(true);
    if (node) {
      node.value = "";
      node.focus({ preventScroll: true });
    }
  }, [keyboardInputActive]);

  const handleKeyboardBeforeInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const nativeEvent = event.nativeEvent as InputEvent;
      if (keyboardComposingRef.current || nativeEvent.isComposing) return;
      switch (nativeEvent.inputType) {
        case "insertText":
        case "insertReplacementText": {
          event.preventDefault();
          sendSteelKeyboardInput({ _tag: "InsertText", text: nativeEvent.data ?? "" });
          event.currentTarget.value = "";
          return;
        }
        case "insertFromPaste": {
          event.preventDefault();
          if (nativeEvent.data) {
            sendSteelKeyboardInput({ _tag: "InsertText", text: nativeEvent.data });
          }
          event.currentTarget.value = "";
          return;
        }
        case "deleteContentBackward":
        case "deleteWordBackward":
        case "deleteSoftLineBackward":
        case "deleteHardLineBackward": {
          event.preventDefault();
          sendSteelKeyboardInput({ _tag: "PressKey", key: "Backspace" });
          event.currentTarget.value = "";
          return;
        }
        case "deleteContentForward":
        case "deleteWordForward":
        case "deleteSoftLineForward":
        case "deleteHardLineForward": {
          event.preventDefault();
          sendSteelKeyboardInput({ _tag: "PressKey", key: "Delete" });
          event.currentTarget.value = "";
          return;
        }
        case "insertLineBreak":
        case "insertParagraph": {
          event.preventDefault();
          sendSteelKeyboardInput({ _tag: "PressKey", key: "Enter" });
          event.currentTarget.value = "";
          return;
        }
      }
    },
    [sendSteelKeyboardInput],
  );

  const handleKeyboardInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      if (keyboardComposingRef.current) return;
      const value = event.currentTarget.value;
      if (value.length > 0) {
        sendSteelKeyboardInput({ _tag: "InsertText", text: value });
        event.currentTarget.value = "";
      }
    },
    [sendSteelKeyboardInput],
  );

  const handleKeyboardPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const text = event.clipboardData.getData("text");
      if (text.length === 0) return;
      event.preventDefault();
      sendSteelKeyboardInput({ _tag: "InsertText", text });
      event.currentTarget.value = "";
    },
    [sendSteelKeyboardInput],
  );

  const handleKeyboardCompositionStart = useCallback(() => {
    keyboardComposingRef.current = true;
  }, []);

  const handleKeyboardCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLTextAreaElement>) => {
      keyboardComposingRef.current = false;
      const text = event.data || event.currentTarget.value;
      if (text.length > 0) {
        sendSteelKeyboardInput({ _tag: "InsertText", text });
      }
      event.currentTarget.value = "";
    },
    [sendSteelKeyboardInput],
  );

  const handleKeyboardKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setKeyboardInputActive(false);
        event.currentTarget.blur();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        sendSteelKeyboardInput({ _tag: "PressKey", key: "Tab" });
        event.currentTarget.value = "";
      }
    },
    [sendSteelKeyboardInput],
  );

  const handleOpenInBrowser = useCallback(() => {
    if (!localApi || !chromeUrl) return;
    void localApi.shell.openExternal(chromeUrl).catch(() => undefined);
  }, [chromeUrl]);

  const handlePendingSteelViewerLoad = useCallback(() => {
    setPendingSteelPreview((current) =>
      current === null || !current.loading ? current : { ...current, loading: false },
    );
  }, []);

  const handleCapture = useCallback(
    (record: boolean) => {
      if (!canUseDesktopBridge || !previewBridge || !tabId) return;
      const bridge = previewBridge;
      const recordingThisTab = activeRecordingTabId === tabId;
      if (recordingThisTab) {
        void stopBrowserRecording(tabId).then(
          (artifact) => {
            if (!artifact) return;
            let pathCopied = false;
            let toastId: ReturnType<typeof toastManager.add>;

            const copyPath = () => {
              if (!navigator.clipboard?.writeText) {
                toastManager.update(
                  toastId,
                  stackedThreadToast({
                    type: "error",
                    title: "Unable to copy recording path",
                    description: "Clipboard API unavailable.",
                    actionProps: revealAction,
                  }),
                );
                return;
              }

              void navigator.clipboard.writeText(artifact.path).then(
                () => {
                  pathCopied = true;
                  updateRecordingToast();
                  window.setTimeout(() => {
                    pathCopied = false;
                    updateRecordingToast();
                  }, 2_000);
                },
                (error) => {
                  toastManager.update(
                    toastId,
                    stackedThreadToast({
                      type: "error",
                      title: "Unable to copy recording path",
                      description: error instanceof Error ? error.message : "An error occurred.",
                      actionProps: revealAction,
                    }),
                  );
                },
              );
            };

            const revealAction = {
              children: revealInFileExplorerLabel(navigator.platform),
              onClick: () => void bridge.revealArtifact(artifact.path),
            };
            const updateRecordingToast = () => {
              toastManager.update(
                toastId,
                stackedThreadToast({
                  type: "success",
                  title: "Recording saved",
                  actionProps: revealAction,
                  data: {
                    secondaryActionProps: {
                      children: pathCopied ? "Copied!" : "Copy path",
                      disabled: pathCopied,
                      onClick: copyPath,
                    },
                    secondaryActionVariant: "outline",
                  },
                }),
              );
            };

            toastId = toastManager.add(
              stackedThreadToast({
                type: "success",
                title: "Recording saved",
                actionProps: revealAction,
                data: {
                  secondaryActionProps: {
                    children: "Copy path",
                    onClick: copyPath,
                  },
                  secondaryActionVariant: "outline",
                },
              }),
            );
          },
          (error) => {
            toastManager.add({
              type: "error",
              title: "Unable to stop recording",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          },
        );
        return;
      }
      if (record) {
        if (activeRecordingTabId !== null) {
          toastManager.add({
            type: "warning",
            title: "Another preview is recording",
            description: "Stop the active recording before starting a new one.",
          });
          return;
        }
        void startBrowserRecording(tabId).catch((error) => {
          toastManager.add({
            type: "error",
            title: "Unable to start recording",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        });
        return;
      }
      void bridge.captureScreenshot(tabId).then(
        (artifact) => {
          let pathCopied = false;
          let imageCopied = false;
          let toastId: ReturnType<typeof toastManager.add>;

          const updateScreenshotToast = (
            type: "success" | "error" = "success",
            title = "Screenshot saved",
            description?: string,
          ) => {
            toastManager.update(
              toastId,
              stackedThreadToast({
                type,
                title,
                description,
                actionProps: {
                  children: imageCopied ? "Copied!" : "Copy image",
                  disabled: imageCopied,
                  onClick: copyImage,
                },
                data: {
                  secondaryActionProps: {
                    children: pathCopied ? "Copied!" : "Copy path",
                    disabled: pathCopied,
                    onClick: copyPath,
                  },
                  secondaryActionVariant: "outline",
                },
              }),
            );
          };

          const copyPath = () => {
            if (!navigator.clipboard?.writeText) {
              updateScreenshotToast(
                "error",
                "Unable to copy screenshot path",
                "Clipboard API unavailable.",
              );
              return;
            }

            void navigator.clipboard.writeText(artifact.path).then(
              () => {
                pathCopied = true;
                updateScreenshotToast();
                window.setTimeout(() => {
                  pathCopied = false;
                  updateScreenshotToast();
                }, 2_000);
              },
              (error) => {
                updateScreenshotToast(
                  "error",
                  "Unable to copy screenshot path",
                  error instanceof Error ? error.message : "An error occurred.",
                );
              },
            );
          };

          const copyImage = () => {
            void bridge.copyArtifactToClipboard(artifact.path).then(
              () => {
                imageCopied = true;
                updateScreenshotToast();
                window.setTimeout(() => {
                  imageCopied = false;
                  updateScreenshotToast();
                }, 2_000);
              },
              (error) => {
                updateScreenshotToast(
                  "error",
                  "Unable to copy screenshot",
                  error instanceof Error ? error.message : "An error occurred.",
                );
              },
            );
          };

          toastId = toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Screenshot saved",
              actionProps: {
                children: "Copy image",
                onClick: copyImage,
              },
              data: {
                secondaryActionProps: {
                  children: "Copy path",
                  onClick: copyPath,
                },
                secondaryActionVariant: "outline",
              },
            }),
          );
        },
        (error) => {
          toastManager.add({
            type: "error",
            title: "Unable to capture screenshot",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        },
      );
    },
    [activeRecordingTabId, canUseDesktopBridge, tabId],
  );

  const handlePickElement = useCallback(() => {
    if (!canUseDesktopBridge || !previewBridge || !tabId) return;
    if (pickActiveRef.current) {
      void previewBridge.cancelPickElement(tabId).catch(() => undefined);
      return;
    }
    // Snapshot whatever the user was focused on (typically the chat
    // composer textarea or the chrome-row pick button) BEFORE main steals
    // focus into the guest webContents. We restore it when the pick
    // resolves so the user's typing context isn't lost — otherwise after
    // every pick they'd have to click back into the textarea.
    const previouslyFocused =
      typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    pickActiveRef.current = true;
    setPickActive(true);
    void (async () => {
      try {
        const annotation = await previewBridge.pickElement(tabId);
        if (!annotation) return;
        addPreviewAnnotation(threadRef, annotation);
        const screenshotFile = await previewAnnotationScreenshotFile(annotation);
        if (screenshotFile && annotation.screenshot) {
          addImage(threadRef, {
            type: "image",
            id: annotation.id,
            name: screenshotFile.name,
            mimeType: screenshotFile.type,
            sizeBytes: screenshotFile.size,
            previewUrl: annotation.screenshot.dataUrl,
            file: screenshotFile,
          });
        }
      } catch {
        // Picker failed (e.g. webview navigated). Treat as silent cancel.
      } finally {
        pickActiveRef.current = false;
        // Avoid `setState on unmounted component` if the panel/thread closed
        // while the pick was in flight.
        if (isMountedRef.current) setPickActive(false);
        // Best-effort: restore focus to whatever the user had before the
        // pick stole it into the guest webContents. Skip if the previously-
        // focused element was unmounted or is no longer focusable.
        if (
          previouslyFocused &&
          previouslyFocused.isConnected &&
          typeof previouslyFocused.focus === "function"
        ) {
          try {
            previouslyFocused.focus({ preventScroll: true });
          } catch {
            // Some elements throw on .focus() (detached iframes, etc.).
          }
        }
      }
    })();
  }, [addImage, addPreviewAnnotation, canUseDesktopBridge, tabId, threadRef]);

  // If the active tab changes mid-pick (close, thread switch, hot restart),
  // tell main to tear down the in-flight session AND reset our local toggle
  // state so the button doesn't get stuck pressed against a stale tab id.
  useEffect(() => {
    return () => {
      if (!pickActiveRef.current) return;
      pickActiveRef.current = false;
      if (canUseDesktopBridge && previewBridge && tabId) {
        void previewBridge.cancelPickElement(tabId).catch(() => undefined);
      }
      if (isMountedRef.current) setPickActive(false);
    };
  }, [canUseDesktopBridge, tabId]);

  // Subscribe only while visible; `toggle-panel` is owned by ChatView's
  // URL-aware handler regardless of whether the panel is currently mounted.
  useEffect(() => {
    if (!visible) return;
    return subscribePreviewAction((action) => {
      switch (action) {
        case "refresh":
          handleRefresh();
          return;
        case "focus-url":
          setFocusUrlNonce((value) => (value ?? 0) + 1);
          return;
        case "zoom-in":
          handleZoomIn();
          return;
        case "zoom-out":
          handleZoomOut();
          return;
        case "reset-zoom":
          handleResetZoom();
          return;
        case "toggle-panel":
          return;
      }
    });
  }, [handleRefresh, handleResetZoom, handleZoomIn, handleZoomOut, visible]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-thread-key={scopedThreadKey(threadRef)}
    >
      <PreviewChromeRow
        url={chromeUrl}
        displayUrl={displayUrl}
        loading={loading}
        loadProgress={loadProgress}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        refreshDisabled={refreshDisabled}
        focusUrlNonce={focusUrlNonce}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onSubmit={handleSubmitUrl}
        onOpenInBrowser={tabId ? handleOpenInBrowser : undefined}
        onCapture={canUseDesktopBridge && tabId ? handleCapture : undefined}
        captureDisabled={!desktopOverlay || isUnreachable}
        recording={tabId !== null && activeRecordingTabId === tabId}
        onKeyboardInput={steelHost && tabId ? handleKeyboardInputToggle : undefined}
        keyboardInputActive={keyboardInputActive}
        onPickElement={canUseDesktopBridge && tabId ? handlePickElement : undefined}
        pickActive={pickActive}
        // Disable when there's no tab (nothing to pick on) OR the page
        // failed to load (a React overlay covers the webview, so the
        // user wouldn't be able to actually click anything underneath).
        pickDisabled={!tabId || isUnreachable}
        pickDisabledReason={
          isUnreachable ? "Page didn't load — pick unavailable until the page renders" : undefined
        }
        trailingActions={
          canUseDesktopBridge ? (
            <PreviewMoreMenu
              tabId={tabId}
              hasWebContents={desktopOverlay !== null}
              zoomFactor={desktopOverlay?.zoomFactor ?? 1}
            />
          ) : null
        }
      />

      <div ref={previewBodyRef} className="relative min-h-0 flex-1 overflow-hidden">
        {showPendingSteelPreview ? (
          <iframe
            key={`pending:${pendingSteelPreview.viewerUrl}:${pendingSteelPreview.url}`}
            title="Mobile browser preview"
            src={pendingSteelPreview.viewerUrl}
            className="absolute inset-0 h-full w-full border-0 bg-background"
            allow="clipboard-read; clipboard-write; fullscreen; microphone; camera"
            sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-scripts"
            onLoad={handlePendingSteelViewerLoad}
          />
        ) : tabId && snapshot && !showEmptyState ? (
          steelHost ? (
            <iframe
              key={`${tabId}:${steelHost.sessionId}:${steelHost.viewerUrl}`}
              title="Mobile browser preview"
              src={steelHost.viewerUrl}
              className="absolute inset-0 h-full w-full border-0 bg-background"
              allow="clipboard-read; clipboard-write; fullscreen; microphone; camera"
              sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-scripts"
            />
          ) : (
            <BrowserSurfaceSlot
              key={tabId}
              tabId={tabId}
              visible={visible && !isUnreachable}
              className="absolute inset-0 h-full w-full"
            />
          )
        ) : null}
        {steelHost ? (
          <textarea
            ref={keyboardProxyRef}
            aria-label="Remote keyboard input"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="enter"
            className={cn(
              "absolute bottom-3 left-3 z-30 h-10 max-h-24 w-[calc(100%-1.5rem)] resize-none rounded-md border border-border bg-background px-3 py-2 text-base leading-5 shadow-md outline-none ring-offset-background transition-opacity focus-visible:ring-2 focus-visible:ring-ring",
              !keyboardInputActive &&
                "pointer-events-none h-px w-px overflow-hidden border-0 p-0 opacity-0 shadow-none",
            )}
            onBeforeInput={handleKeyboardBeforeInput}
            onInput={handleKeyboardInput}
            onPaste={handleKeyboardPaste}
            onCompositionStart={handleKeyboardCompositionStart}
            onCompositionEnd={handleKeyboardCompositionEnd}
            onKeyDown={handleKeyboardKeyDown}
            onFocus={() => setKeyboardInputActive(true)}
            onBlur={() => setKeyboardInputActive(false)}
          />
        ) : null}
        {showEmptyState && !showPendingSteelPreview ? (
          <PreviewEmptyState
            environmentId={threadRef.environmentId}
            configuredUrls={configuredUrls}
            recentlySeenUrls={previewState.recentlySeenUrls}
            onOpenUrl={(next) => void handleSubmitUrl(next)}
          />
        ) : null}
        {snapshot && desktopOverlay ? (
          <ZoomIndicator zoomFactor={desktopOverlay.zoomFactor} />
        ) : null}
        {tabId && desktopOverlay && !showEmptyState && !isUnreachable ? (
          <AgentBrowserCursor
            tabId={tabId}
            zoomFactor={desktopOverlay.zoomFactor}
            controller={controller}
          />
        ) : null}
        {controller !== "none" ? (
          <div className="pointer-events-none absolute left-3 top-3 z-40 rounded-full border border-border/70 bg-background/90 px-2.5 py-1 text-[11px] font-medium shadow-sm backdrop-blur">
            {controller === "agent" ? "Agent controlling browser" : "Human control"}
          </div>
        ) : null}
        {navStatus._tag === "LoadFailed" ? (
          <div className="absolute inset-0 z-10 bg-background">
            <PreviewUnreachable
              url={navStatus.url}
              code={navStatus.code}
              description={navStatus.description}
              onReload={handleRefresh}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
