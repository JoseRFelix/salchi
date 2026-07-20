import "../../index.css";

import { EnvironmentId, type TranscriptionModel } from "@salchi/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerDictationButton } from "./ComposerDictationButton";
import { installDictationMediaMocks } from "./dictationMediaTestUtils";

const harness = vi.hoisted(() => ({
  model: "base.en" as TranscriptionModel,
  fetchStatus: vi.fn(async () =>
    Response.json({
      configured: true,
      state: "ready",
      downloadedBytes: null,
      totalBytes: null,
      message: null,
    }),
  ),
}));

vi.mock("~/hooks/useSettings", () => ({
  useSettings: (selector?: (settings: { transcriptionModel: TranscriptionModel }) => unknown) => {
    const settings = { transcriptionModel: harness.model };
    return selector ? selector(settings) : settings;
  },
}));

vi.mock("../../environments/runtime", () => {
  return { fetchEnvironmentHttp: harness.fetchStatus };
});

describe("ComposerDictationButton status lifecycle", () => {
  let restoreMediaMocks: (() => void) | null = null;

  afterEach(() => {
    harness.model = "base.en";
    harness.fetchStatus.mockClear();
    restoreMediaMocks?.();
    restoreMediaMocks = null;
    document.body.innerHTML = "";
  });

  it("fetches a fresh status when the selected local model changes", async () => {
    ({ restore: restoreMediaMocks } = installDictationMediaMocks({
      getUserMedia: vi.fn(async () => new MediaStream()),
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const environmentId = EnvironmentId.make("local");
    const renderButton = () => (
      <QueryClientProvider client={queryClient}>
        <ComposerDictationButton
          recordingOwnerKey="status-lifecycle-owner"
          environmentId={environmentId}
          disabled={false}
          onTranscript={() => undefined}
        />
      </QueryClientProvider>
    );
    const screen = await render(renderButton());

    try {
      await vi.waitFor(() => {
        expect(harness.fetchStatus).toHaveBeenCalledTimes(1);
      });

      harness.model = "small.en";
      await screen.rerender(renderButton());

      await vi.waitFor(() => {
        expect(harness.fetchStatus).toHaveBeenCalledTimes(2);
      });

      harness.model = "base.en";
      await screen.rerender(renderButton());

      await vi.waitFor(() => {
        expect(harness.fetchStatus).toHaveBeenCalledTimes(3);
      });
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      ).toEqual(
        expect.arrayContaining([
          ["local-transcription-status", environmentId, "base.en"],
          ["local-transcription-status", environmentId, "small.en"],
        ]),
      );
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });
});
