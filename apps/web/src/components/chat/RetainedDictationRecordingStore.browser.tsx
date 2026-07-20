import { EnvironmentId } from "@salchi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearRetainedDictationRecordingMemoryForTests,
  createDictationRecordingOwnerKey,
  discardRetainedDictationRecording,
  loadRetainedDictationRecording,
  RETAINED_DICTATION_RECORDING_MAX_AGE_MS,
  type RetainedDictationRecording,
  resetRetainedDictationRecordingStoreForTests,
  retainDictationRecording,
} from "../../retainedDictationRecordingStore";

const environmentId = EnvironmentId.make("dictation-persistence-environment");

function recording(
  ownerKey: string,
  overrides: Partial<RetainedDictationRecording> = {},
): RetainedDictationRecording {
  return {
    id: "recording-1",
    ownerKey,
    environmentId,
    audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
    normalizedAudio: new Blob([new Uint8Array([4, 5, 6])], { type: "audio/wav" }),
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(async () => {
  await resetRetainedDictationRecordingStoreForTests();
});

afterEach(async () => {
  await resetRetainedDictationRecordingStoreForTests();
});

describe("retained dictation recording persistence", () => {
  it("round-trips audio through IndexedDB after the in-memory layer is cleared", async () => {
    const ownerKey = createDictationRecordingOwnerKey({
      kind: "thread",
      environmentId,
      threadId: "thread-1",
    });
    const source = recording(ownerKey);

    await expect(retainDictationRecording(source)).resolves.toBe(true);
    clearRetainedDictationRecordingMemoryForTests();
    const restored = await loadRetainedDictationRecording(ownerKey);

    expect(restored).toMatchObject({
      id: source.id,
      ownerKey,
      environmentId,
      createdAt: source.createdAt,
    });
    expect(Array.from(new Uint8Array(await restored!.audio.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(Array.from(new Uint8Array(await restored!.normalizedAudio!.arrayBuffer()))).toEqual([
      4, 5, 6,
    ]);
  });

  it("serializes retain and discard so a late write cannot resurrect audio", async () => {
    const ownerKey = createDictationRecordingOwnerKey({
      kind: "thread",
      environmentId,
      threadId: "thread-concurrent",
    });
    const source = recording(ownerKey);

    const retainPromise = retainDictationRecording(source);
    const discardPromise = discardRetainedDictationRecording(ownerKey, source.id);
    await Promise.all([retainPromise, discardPromise]);
    clearRetainedDictationRecordingMemoryForTests();

    await expect(loadRetainedDictationRecording(ownerKey)).resolves.toBeNull();
  });

  it("does not let stale completion delete a newer recording for the same owner", async () => {
    const ownerKey = createDictationRecordingOwnerKey({
      kind: "thread",
      environmentId,
      threadId: "thread-replaced",
    });
    const first = recording(ownerKey, { id: "recording-old" });
    const replacement = recording(ownerKey, { id: "recording-new" });

    await retainDictationRecording(first);
    await retainDictationRecording(replacement);
    await discardRetainedDictationRecording(ownerKey, first.id);
    clearRetainedDictationRecordingMemoryForTests();

    await expect(loadRetainedDictationRecording(ownerKey)).resolves.toMatchObject({
      id: replacement.id,
    });
  });

  it("expires old recordings and keeps owner keys collision-safe", async () => {
    const firstOwner = createDictationRecordingOwnerKey({
      kind: "thread",
      environmentId: "a:b",
      threadId: "c",
    });
    const secondOwner = createDictationRecordingOwnerKey({
      kind: "thread",
      environmentId: "a",
      threadId: "b:c",
    });
    expect(firstOwner).not.toBe(secondOwner);

    const expired = recording(firstOwner, {
      createdAt: Date.now() - RETAINED_DICTATION_RECORDING_MAX_AGE_MS - 1,
    });
    await retainDictationRecording(expired);
    clearRetainedDictationRecordingMemoryForTests();

    await expect(loadRetainedDictationRecording(firstOwner)).resolves.toBeNull();
  });
});
