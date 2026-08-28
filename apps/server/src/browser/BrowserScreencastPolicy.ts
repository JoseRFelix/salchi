export const BROWSER_SCREENCAST_INTERACTION_BOOST_MILLIS = 2_000;

/**
 * A sampled screencast can miss a page's only compositor paint when it starts
 * after a static page is already rendered. Prime one frame at full cadence,
 * then restart CDP at the desired cadence without replacing the mailbox.
 */
export function browserScreencastEveryNthFrameForStart(
  desiredEveryNthFrame: number,
  primeInitialFrame: boolean,
): number {
  return primeInitialFrame ? 1 : desiredEveryNthFrame;
}

export interface BrowserScreencastFrameRateController {
  readonly dispose: () => void;
  readonly recordInput: () => void;
}

/**
 * Debounces the temporary interactive frame-rate boost with one bounded timer.
 * The runtime owns the controller and disposes it from the browser session scope.
 */
export function makeBrowserScreencastFrameRateController(input: {
  readonly configuredEveryNthFrame: number;
  readonly onEveryNthFrameChange: (everyNthFrame: number) => void;
  readonly boostMillis?: number;
  readonly setTimer?: (callback: () => void, millis: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}): BrowserScreencastFrameRateController {
  const setTimer = input.setTimer ?? setTimeout;
  const clearTimer = input.clearTimer ?? clearTimeout;
  const boostMillis = input.boostMillis ?? BROWSER_SCREENCAST_INTERACTION_BOOST_MILLIS;
  let currentEveryNthFrame = input.configuredEveryNthFrame;
  let decayTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const setEveryNthFrame = (everyNthFrame: number) => {
    if (disposed || currentEveryNthFrame === everyNthFrame) return;
    currentEveryNthFrame = everyNthFrame;
    input.onEveryNthFrameChange(everyNthFrame);
  };

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (decayTimer !== undefined) clearTimer(decayTimer);
      decayTimer = undefined;
    },
    recordInput: () => {
      if (disposed || input.configuredEveryNthFrame === 1) return;
      setEveryNthFrame(1);
      if (decayTimer !== undefined) clearTimer(decayTimer);
      decayTimer = setTimer(() => {
        decayTimer = undefined;
        setEveryNthFrame(input.configuredEveryNthFrame);
      }, boostMillis);
    },
  };
}
