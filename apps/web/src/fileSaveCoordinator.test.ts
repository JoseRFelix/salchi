import { afterEach, describe, expect, it, vi } from "vitest";

import { FileSaveCoordinator } from "./fileSaveCoordinator";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("FileSaveCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces edits and persists only the latest contents", async () => {
    vi.useFakeTimers();
    const persist = vi.fn<(contents: string) => Promise<void>>().mockResolvedValue(undefined);
    const onPendingChange = vi.fn();
    const onConfirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed,
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(300);
    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(499);
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("latest");
    expect(onConfirmed).toHaveBeenCalledWith("latest");
    expect(onPendingChange.mock.calls).toEqual([[true], [true], [false]]);
  });

  it("ignores editor changes that match the initially loaded contents", async () => {
    vi.useFakeTimers();
    const persist = vi.fn<(contents: string) => Promise<void>>().mockResolvedValue(undefined);
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      initialContents: "original",
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("original");
    await vi.advanceTimersByTimeAsync(500);

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenCalledWith(false);
  });

  it("does not reschedule the debounce for duplicate pending contents", async () => {
    vi.useFakeTimers();
    const persist = vi.fn<(contents: string) => Promise<void>>().mockResolvedValue(undefined);
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      initialContents: "original",
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("updated");
    await vi.advanceTimersByTimeAsync(300);
    coordinator.change("updated");
    await vi.advanceTimersByTimeAsync(199);
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("updated");
  });

  it("cancels a pending save when contents return to the confirmed value before debounce", async () => {
    vi.useFakeTimers();
    const persist = vi.fn<(contents: string) => Promise<void>>().mockResolvedValue(undefined);
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      initialContents: "original",
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("updated");
    await vi.advanceTimersByTimeAsync(300);
    coordinator.change("original");
    await vi.advanceTimersByTimeAsync(500);

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
  });

  it("keeps pending state until an edit made during a write is also saved", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<void>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(undefined);
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("persists a revert to confirmed contents when an earlier write is already in flight", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<void>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(undefined);
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      initialContents: "original",
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("updated");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("original");

    firstWrite.resolve();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenNthCalledWith(1, "updated");
    expect(persist).toHaveBeenNthCalledWith(2, "original");
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("leaves the file pending when the latest write fails", async () => {
    vi.useFakeTimers();
    const onPendingChange = vi.fn();
    const onError = vi.fn();
    const error = new Error("write failed");
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist: vi.fn().mockRejectedValue(error),
      onPendingChange,
      onConfirmed: vi.fn(),
      onError,
    });

    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(onPendingChange).toHaveBeenCalledWith(true);
    expect(onPendingChange).not.toHaveBeenCalledWith(false);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("persists pending changes before dispose completes", async () => {
    vi.useFakeTimers();
    const persist = vi.fn<(contents: string) => Promise<void>>().mockResolvedValue(undefined);
    const onConfirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed,
    });

    coordinator.change("first");
    coordinator.change("latest");

    await coordinator.dispose();

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("latest");
    expect(onConfirmed).toHaveBeenCalledWith("latest");
  });

  it("waits for an in-flight persist and saves newer dispose-time revisions", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<void>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(undefined);
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");

    const disposePromise = coordinator.dispose();
    expect(persist).toHaveBeenCalledOnce();

    firstWrite.resolve();
    await disposePromise;

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
  });

  it("disposes idempotently without duplicate persists", async () => {
    vi.useFakeTimers();
    const persist = vi.fn<(contents: string) => Promise<void>>().mockResolvedValue(undefined);
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("latest");

    const firstDispose = coordinator.dispose();
    const secondDispose = coordinator.dispose();

    expect(secondDispose).toBe(firstDispose);
    await Promise.all([firstDispose, secondDispose]);
    await coordinator.dispose();

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("latest");
  });
});
