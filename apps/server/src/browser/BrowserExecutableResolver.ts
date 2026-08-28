import {
  BrowserUnavailable,
  type BrowserExecutableResolutionAttempt,
  type BrowserExecutableSource,
} from "@salchi/contracts";
import * as Effect from "effect/Effect";

export const DEFAULT_BROWSER_CHANNELS = ["chrome", "chromium", "msedge"] as const;

export interface BrowserResolutionCandidate {
  readonly source: BrowserExecutableSource;
  readonly resolution: string;
  readonly launchOptions: { readonly executablePath: string } | { readonly channel: string };
}

export function makeBrowserResolutionCandidates(input: {
  readonly environmentPath?: string | undefined;
  readonly settingPath?: string | undefined;
  readonly channels?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<BrowserResolutionCandidate> {
  const candidates: BrowserResolutionCandidate[] = [];
  const environmentPath = input.environmentPath?.trim();
  const settingPath = input.settingPath?.trim();

  if (environmentPath) {
    candidates.push({
      source: "environment",
      resolution: environmentPath,
      launchOptions: { executablePath: environmentPath },
    });
  }
  if (settingPath) {
    candidates.push({
      source: "setting",
      resolution: settingPath,
      launchOptions: { executablePath: settingPath },
    });
  }
  for (const channel of input.channels ?? DEFAULT_BROWSER_CHANNELS) {
    candidates.push({
      source: "channel",
      resolution: channel,
      launchOptions: { channel },
    });
  }
  return candidates;
}

function failureDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function resolveBrowserExecutable<A, E>(input: {
  readonly candidates: ReadonlyArray<BrowserResolutionCandidate>;
  readonly launch: (candidate: BrowserResolutionCandidate) => Effect.Effect<A, E>;
}): Effect.Effect<
  { readonly value: A; readonly candidate: BrowserResolutionCandidate },
  BrowserUnavailable
> {
  const failures: BrowserExecutableResolutionAttempt[] = [];

  const loop = (
    index: number,
  ): Effect.Effect<
    { readonly value: A; readonly candidate: BrowserResolutionCandidate },
    BrowserUnavailable
  > => {
    const candidate = input.candidates[index];
    if (candidate === undefined) {
      const summary =
        failures.length === 0
          ? "No browser executable resolution candidates were configured."
          : failures
              .map((attempt) => `${attempt.source}:${attempt.resolution} (${attempt.error})`)
              .join("; ");
      return Effect.fail(
        new BrowserUnavailable({
          message: `Unable to launch Chromium. Attempts: ${summary}`,
          attempts: failures,
        }),
      );
    }

    return input.launch(candidate).pipe(
      Effect.map((value) => ({ value, candidate })),
      Effect.catch((error) => {
        failures.push({
          source: candidate.source,
          resolution: candidate.resolution,
          error: failureDetail(error),
        });
        return loop(index + 1);
      }),
    );
  };

  return Effect.suspend(() => loop(0));
}
