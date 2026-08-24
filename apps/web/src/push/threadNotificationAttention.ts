const FOCUSED_THREAD_UPDATE_CLEAR_DELAYS_MS = [0, 5000, 6000, 9000] as const;

// Chrome may focus/show a page before dispatching the service worker's
// notificationclick event. Visibility/focus activation must not close the
// notification that Chrome is still trying to activate.
const THREAD_ACTIVATION_CLEAR_DELAYS_MS = [5000, 6000, 9000] as const;

interface DocumentAttentionTarget {
  readonly visibilityState: DocumentVisibilityState;
  readonly hasFocus: () => boolean;
}

interface ThreadNotificationAttentionControllerInput {
  readonly clearThreadNotifications: () => void | Promise<void>;
  readonly isActivelyViewed: () => boolean;
}

export interface ThreadNotificationAttentionController {
  readonly acknowledgeCurrentState: () => void;
  readonly acknowledgeAfterActivation: () => void;
  readonly dispose: () => void;
}

export function isDocumentActivelyViewed(
  documentTarget: DocumentAttentionTarget | null = typeof document === "undefined"
    ? null
    : document,
): boolean {
  if (documentTarget?.visibilityState !== "visible") {
    return false;
  }
  try {
    return documentTarget.hasFocus();
  } catch {
    return false;
  }
}

export function createThreadNotificationAttentionController(
  input: ThreadNotificationAttentionControllerInput,
): ThreadNotificationAttentionController {
  let generation = 0;
  let timerIds: Array<ReturnType<typeof setTimeout>> = [];

  const cancelScheduledAttempts = () => {
    generation += 1;
    for (const timerId of timerIds) {
      clearTimeout(timerId);
    }
    timerIds = [];
  };

  const scheduleAttempts = (delays: readonly number[]) => {
    cancelScheduledAttempts();
    if (!input.isActivelyViewed()) {
      return;
    }

    const scheduledGeneration = generation;
    for (const delay of delays) {
      const timerId = setTimeout(() => {
        timerIds = timerIds.filter((candidate) => candidate !== timerId);
        if (scheduledGeneration !== generation || !input.isActivelyViewed()) {
          return;
        }
        try {
          void Promise.resolve(input.clearThreadNotifications()).catch(() => undefined);
        } catch {
          // Notification cleanup is best-effort and must not disrupt the thread view.
        }
      }, delay);
      timerIds.push(timerId);
    }
  };

  return {
    acknowledgeCurrentState: () => {
      scheduleAttempts(FOCUSED_THREAD_UPDATE_CLEAR_DELAYS_MS);
    },
    acknowledgeAfterActivation: () => {
      scheduleAttempts(THREAD_ACTIVATION_CLEAR_DELAYS_MS);
    },
    dispose: cancelScheduledAttempts,
  };
}
