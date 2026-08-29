import type {
  BrowserInstallProgress,
  BrowserManagedVariant,
  EnvironmentId,
  ThreadId,
} from "@salchi/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { readEnvironmentConnection } from "../environments/runtime";
import {
  browserErrorMessage,
  browserUnavailableDetails,
  isBrowserAuthorizationError,
  type BrowserViewportState,
  type BrowserViewportStateAction,
} from "./browserViewportState";

export type ManagedBrowserInstallOperation =
  | "cancel-install"
  | "check-install"
  | "install"
  | "select-variant"
  | "start";

export function useManagedBrowserInstall(input: {
  readonly active: boolean;
  readonly environmentId: EnvironmentId;
  readonly onStateAction: (action: BrowserViewportStateAction) => void;
  readonly state: BrowserViewportState;
  readonly threadId: ThreadId;
}) {
  const [pendingOperation, setPendingOperation] = useState<ManagedBrowserInstallOperation | null>(
    null,
  );
  const generationRef = useRef(0);
  const managedVariant = input.state.installState?.variant ?? "headless-shell";

  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [],
  );

  const handleFailure = useCallback(
    (error: unknown, fallback: string) => {
      if (isBrowserAuthorizationError(error)) {
        input.onStateAction({ type: "authorizationDenied" });
        return;
      }
      const unavailable = browserUnavailableDetails(error);
      if (unavailable !== null) {
        input.onStateAction({
          type: "browserUnavailable",
          error: unavailable.message,
          reason: unavailable.reason,
          ...(unavailable.dependencyCommand === undefined
            ? {}
            : { dependencyCommand: unavailable.dependencyCommand }),
        });
        return;
      }
      input.onStateAction({
        type: "operationFailed",
        error: browserErrorMessage(error, fallback),
        status: "stopped",
      });
    },
    [input.onStateAction],
  );

  const start = useCallback(async () => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setPendingOperation("start");
    input.onStateAction({ type: "startRequested" });
    try {
      const client = readEnvironmentConnection(input.environmentId)?.client.browser;
      if (!client) throw new Error("The environment connection is unavailable.");
      const snapshot = await client.start({ threadId: input.threadId });
      if (generation !== generationRef.current) return;
      input.onStateAction({ type: "snapshot", snapshot });
    } catch (error: unknown) {
      if (generation === generationRef.current) {
        handleFailure(error, "Unable to start Chromium.");
      }
    } finally {
      if (generation === generationRef.current) setPendingOperation(null);
    }
  }, [handleFailure, input.environmentId, input.onStateAction, input.threadId]);

  const install = useCallback(async () => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setPendingOperation("install");
    input.onStateAction({ type: "clearOperationError" });
    try {
      const client = readEnvironmentConnection(input.environmentId)?.client.browser;
      if (!client) throw new Error("The environment connection is unavailable.");
      await client.install(
        { threadId: input.threadId, variant: managedVariant },
        (progress: BrowserInstallProgress) => {
          if (generation === generationRef.current) {
            input.onStateAction({ type: "installProgress", variant: managedVariant, progress });
          }
        },
      );
      if (generation !== generationRef.current) return;
      const installState = await client.getInstallState({ threadId: input.threadId });
      if (generation !== generationRef.current) return;
      input.onStateAction({ type: "installState", installState });
      if (installState.status !== "installed") return;

      input.onStateAction({ type: "startRequested" });
      const snapshot = await client.start({ threadId: input.threadId });
      if (generation !== generationRef.current) return;
      input.onStateAction({ type: "snapshot", snapshot });
    } catch (error: unknown) {
      if (generation !== generationRef.current) return;
      if (isBrowserAuthorizationError(error)) {
        input.onStateAction({ type: "authorizationDenied" });
      } else {
        const client = readEnvironmentConnection(input.environmentId)?.client.browser;
        const installState = await client
          ?.getInstallState({ threadId: input.threadId })
          .catch(() => null);
        if (generation !== generationRef.current) return;
        if (installState) input.onStateAction({ type: "installState", installState });
        const unavailable = browserUnavailableDetails(error);
        if (unavailable !== null) {
          handleFailure(error, "Chromium installation failed.");
        } else {
          input.onStateAction({
            type: "operationFailed",
            error: browserErrorMessage(error, "Chromium installation failed."),
            status: "stopped",
          });
        }
      }
    } finally {
      if (generation === generationRef.current) setPendingOperation(null);
    }
  }, [handleFailure, input.environmentId, input.onStateAction, input.threadId, managedVariant]);

  const cancel = useCallback(async () => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setPendingOperation("cancel-install");
    try {
      const client = readEnvironmentConnection(input.environmentId)?.client.browser;
      if (!client) throw new Error("The environment connection is unavailable.");
      const installState = await client.cancelInstall({ threadId: input.threadId });
      if (generation === generationRef.current) {
        input.onStateAction({ type: "installState", installState });
      }
    } catch (error: unknown) {
      if (generation === generationRef.current) {
        handleFailure(error, "Unable to cancel Chromium installation.");
      }
    } finally {
      if (generation === generationRef.current) setPendingOperation(null);
    }
  }, [handleFailure, input.environmentId, input.onStateAction, input.threadId]);

  const checkAgain = useCallback(async () => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setPendingOperation("check-install");
    input.onStateAction({ type: "clearOperationError" });
    try {
      const client = readEnvironmentConnection(input.environmentId)?.client.browser;
      if (!client) throw new Error("The environment connection is unavailable.");
      await client.cancelInstall({ threadId: input.threadId });
      const installState = await client.getInstallState({ threadId: input.threadId });
      if (generation !== generationRef.current) return;
      input.onStateAction({ type: "installState", installState });
      if (installState.status !== "installed") return;

      input.onStateAction({ type: "startRequested" });
      const snapshot = await client.start({ threadId: input.threadId });
      if (generation !== generationRef.current) return;
      input.onStateAction({ type: "snapshot", snapshot });
    } catch (error: unknown) {
      if (generation === generationRef.current) {
        handleFailure(error, "Unable to check for Google Chrome.");
      }
    } finally {
      if (generation === generationRef.current) setPendingOperation(null);
    }
  }, [handleFailure, input.environmentId, input.onStateAction, input.threadId]);

  const selectVariant = useCallback(
    async (variant: BrowserManagedVariant) => {
      if (variant === managedVariant) return;
      generationRef.current += 1;
      const generation = generationRef.current;
      setPendingOperation("select-variant");
      input.onStateAction({ type: "clearOperationError" });
      try {
        const connection = readEnvironmentConnection(input.environmentId);
        if (!connection) throw new Error("The environment connection is unavailable.");
        await connection.client.server.updateSettings({ browserManagedVariant: variant });
        const installState = await connection.client.browser.getInstallState({
          threadId: input.threadId,
        });
        if (generation !== generationRef.current) return;
        input.onStateAction({ type: "installState", installState, preserveUnavailable: true });
      } catch (error: unknown) {
        if (generation === generationRef.current) {
          handleFailure(error, "Unable to save the managed browser choice.");
        }
      } finally {
        if (generation === generationRef.current) setPendingOperation(null);
      }
    },
    [handleFailure, input.environmentId, input.onStateAction, input.threadId, managedVariant],
  );

  useEffect(() => {
    if (
      !input.active ||
      input.state.unavailableReason !== "not-installed" ||
      input.state.installState?.status !== "installing" ||
      pendingOperation !== null
    ) {
      return;
    }
    void install();
  }, [
    input.active,
    input.state.installState?.status,
    input.state.unavailableReason,
    install,
    pendingOperation,
  ]);

  return {
    cancel,
    checkAgain,
    install,
    managedVariant,
    pendingOperation,
    selectVariant,
    start,
  } as const;
}
