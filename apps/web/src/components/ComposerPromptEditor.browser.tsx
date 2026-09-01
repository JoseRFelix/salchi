import { createRef, useImperativeHandle, useState, type RefObject } from "react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

const IOS_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1";

type EditorHarnessHandle = {
  setCursor: (cursor: number) => void;
  setIdentity: (identity: string) => void;
  setSkills: (skills: Parameters<typeof ComposerPromptEditor>[0]["skills"]) => void;
};

function EditorHarness(props: {
  controlsRef: RefObject<EditorHarnessHandle | null>;
  editorRef: RefObject<ComposerPromptEditorHandle | null>;
  initialCursor?: number;
  initialIdentity?: string;
  initialValue?: string;
  syncControlledCursor?: boolean;
}) {
  const [value, setValue] = useState(props.initialValue ?? "");
  const [cursor, setCursor] = useState(props.initialCursor ?? 0);
  const [identity, setIdentity] = useState(props.initialIdentity ?? "native-ios-input");
  const [skills, setSkills] = useState<Parameters<typeof ComposerPromptEditor>[0]["skills"]>([]);

  useImperativeHandle(props.controlsRef, () => ({ setCursor, setIdentity, setSkills }), []);

  return (
    <ComposerPromptEditor
      editorIdentity={identity}
      value={value}
      cursor={cursor}
      terminalContexts={[]}
      skills={skills}
      disabled={false}
      placeholder="Ask anything"
      onRemoveTerminalContext={() => undefined}
      onChange={(nextValue, nextCursor) => {
        setValue(nextValue);
        if (props.syncControlledCursor) {
          setCursor(nextCursor);
        }
      }}
      onPaste={() => undefined}
      editorRef={props.editorRef}
    />
  );
}

function setIosUserAgent(): void {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: IOS_USER_AGENT,
  });
}

function insertNativeComposerText(
  editor: HTMLElement,
  data: string,
  inputType = "insertText",
): InputEvent {
  const beforeInputEvent = new InputEvent("beforeinput", {
    data,
    inputType,
    bubbles: true,
    cancelable: true,
  });
  editor.dispatchEvent(beforeInputEvent);
  expect(beforeInputEvent.defaultPrevented).toBe(false);

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    throw new Error("Unable to resolve the composer selection.");
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  if (range.startContainer instanceof Text) {
    range.startContainer.insertData(range.startOffset, data);
    range.setStart(range.startContainer, range.startOffset + data.length);
  } else {
    const textNode = document.createTextNode(data);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  editor.dispatchEvent(
    new InputEvent("input", {
      data,
      inputType,
      bubbles: true,
    }),
  );

  return beforeInputEvent;
}

function readDomSelectionOffset(editor: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed || !selection.anchorNode) {
    throw new Error("Unable to resolve the composer selection.");
  }
  if (!editor.contains(selection.anchorNode) && selection.anchorNode !== editor) {
    throw new Error("Composer selection is outside the editor.");
  }
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
}

async function waitForAnimationFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function dispatchHistoryBeforeInput(editor: HTMLElement, inputType: "historyRedo" | "historyUndo") {
  const event = new InputEvent("beforeinput", {
    inputType,
    bubbles: true,
    cancelable: true,
  });
  editor.dispatchEvent(event);
  return event;
}

function dispatchTextPaste(editor: HTMLElement, text: string): ClipboardEvent {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  const event = new ClipboardEvent("paste", {
    clipboardData,
    bubbles: true,
    cancelable: true,
  });
  editor.dispatchEvent(event);
  return event;
}

function dispatchTextDropBeforeInput(editor: HTMLElement, text: string): InputEvent {
  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/plain", text);
  const event = new InputEvent("beforeinput", {
    inputType: "insertFromDrop",
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  editor.dispatchEvent(event);
  return event;
}

describe("ComposerPromptEditor native iOS input", () => {
  const originalUserAgentDescriptor = Object.getOwnPropertyDescriptor(navigator, "userAgent");

  afterEach(() => {
    if (originalUserAgentDescriptor) {
      Object.defineProperty(navigator, "userAgent", originalUserAgentDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "userAgent");
    }
    document.body.innerHTML = "";
  });

  it("keeps sequential desktop keyboard input ordered while the controlled cursor lags", async () => {
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const controlsRef = createRef<EditorHarnessHandle>();
    const screen = await render(
      <EditorHarness
        controlsRef={controlsRef}
        editorRef={editorRef}
        initialIdentity="desktop-keyboard-input"
      />,
    );

    try {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(editor).not.toBeNull();
      editor?.focus();

      await userEvent.keyboard("the heck");

      await vi.waitFor(() => {
        expect(editor?.textContent).toBe("the heck");
        expect(editorRef.current?.readSnapshot()).toMatchObject({
          value: "the heck",
          cursor: "the heck".length,
        });
        expect(readDomSelectionOffset(editor!)).toBe("the heck".length);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("preserves a focused browser-owned cursor when skill metadata changes", async () => {
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const controlsRef = createRef<EditorHarnessHandle>();
    const screen = await render(
      <EditorHarness
        controlsRef={controlsRef}
        editorRef={editorRef}
        initialIdentity="desktop-skill-refresh"
      />,
    );

    try {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(editor).not.toBeNull();
      editor?.focus();
      await userEvent.keyboard("abcdef");
      await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
      await vi.waitFor(() => expect(readDomSelectionOffset(editor!)).toBe(3));

      controlsRef.current?.setSkills([
        {
          name: "regression-test",
          path: "/skills/regression-test/SKILL.md",
          enabled: true,
        },
      ]);

      await waitForAnimationFrame();
      await waitForAnimationFrame();
      expect(editorRef.current?.readSnapshot().cursor).toBe(3);
      expect(readDomSelectionOffset(editor!)).toBe(3);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps streamed dictation chunks ordered while the controlled cursor lags", async () => {
    setIosUserAgent();
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const controlsRef = createRef<EditorHarnessHandle>();
    const screen = await render(<EditorHarness controlsRef={controlsRef} editorRef={editorRef} />);

    try {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(editor).not.toBeNull();
      editor?.focus();

      insertNativeComposerText(editor!, "Hello ");
      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot()).toMatchObject({ value: "Hello ", cursor: 6 });
        expect(readDomSelectionOffset(editor!)).toBe(6);
      });
      insertNativeComposerText(editor!, "from ");
      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot()).toMatchObject({
          value: "Hello from ",
          cursor: 11,
        });
        expect(readDomSelectionOffset(editor!)).toBe(11);
      });
      insertNativeComposerText(editor!, "dictation");

      await vi.waitFor(() => {
        expect(editor?.textContent).toBe("Hello from dictation");
        expect(editorRef.current?.readSnapshot()).toMatchObject({
          value: "Hello from dictation",
          cursor: "Hello from dictation".length,
        });
        expect(readDomSelectionOffset(editor!)).toBe("Hello from dictation".length);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("handles rapid empty-inputType dictation chunks without an intermediate render", async () => {
    setIosUserAgent();
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const controlsRef = createRef<EditorHarnessHandle>();
    const screen = await render(<EditorHarness controlsRef={controlsRef} editorRef={editorRef} />);

    try {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(editor).not.toBeNull();
      editor?.focus();

      insertNativeComposerText(editor!, "rapid ", "");
      insertNativeComposerText(editor!, "native ", "");
      insertNativeComposerText(editor!, "dictation", "");

      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot()).toMatchObject({
          value: "rapid native dictation",
          cursor: "rapid native dictation".length,
        });
        expect(readDomSelectionOffset(editor!)).toBe("rapid native dictation".length);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("applies an authoritative controlled cursor change during native settling", async () => {
    setIosUserAgent();
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const controlsRef = createRef<EditorHarnessHandle>();
    const screen = await render(
      <EditorHarness
        controlsRef={controlsRef}
        editorRef={editorRef}
        initialValue="abcdef"
        initialCursor={3}
      />,
    );

    try {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(editor).not.toBeNull();
      editorRef.current?.focusAt(3);
      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot().cursor).toBe(3);
        expect(readDomSelectionOffset(editor!)).toBe(3);
      });
      insertNativeComposerText(editor!, "X");
      controlsRef.current?.setCursor(1);

      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot()).toMatchObject({ value: "abcXdef", cursor: 1 });
        expect(readDomSelectionOffset(editor!)).toBe(1);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("resets selection and history when editor ownership changes while blurred", async () => {
    setIosUserAgent();
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const controlsRef = createRef<EditorHarnessHandle>();
    const screen = await render(
      <EditorHarness
        controlsRef={controlsRef}
        editorRef={editorRef}
        initialValue="abcdef"
        initialCursor={3}
        initialIdentity="thread:a"
      />,
    );

    try {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(editor).not.toBeNull();
      editorRef.current?.focusAt(3);
      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot().cursor).toBe(3);
        expect(readDomSelectionOffset(editor!)).toBe(3);
      });
      insertNativeComposerText(editor!, "X");
      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot()).toMatchObject({ value: "abcXdef", cursor: 4 });
      });

      editor?.blur();
      expect(document.activeElement).not.toBe(editor);
      controlsRef.current?.setIdentity("thread:b");
      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot()).toMatchObject({ value: "abcXdef", cursor: 3 });
        expect(document.activeElement).not.toBe(editor);
      });

      editorRef.current?.focusAt(3);
      const undoEvent = dispatchHistoryBeforeInput(editor!, "historyUndo");
      expect(undoEvent.defaultPrevented).toBe(true);
      await waitForAnimationFrame();
      expect(editorRef.current?.readSnapshot().value).toBe("abcXdef");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps browser-owned native input in Lexical undo and redo history exactly once", async () => {
    setIosUserAgent();
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const controlsRef = createRef<EditorHarnessHandle>();
    const screen = await render(
      <EditorHarness controlsRef={controlsRef} editorRef={editorRef} syncControlledCursor />,
    );

    try {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(editor).not.toBeNull();
      editor?.focus();
      await waitForAnimationFrame();
      insertNativeComposerText(editor!, "dictated once");
      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot().value).toBe("dictated once");
      });

      const undoEvent = dispatchHistoryBeforeInput(editor!, "historyUndo");
      expect(undoEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot()).toMatchObject({ value: "", cursor: 0 });
      });

      const redoEvent = dispatchHistoryBeforeInput(editor!, "historyRedo");
      expect(redoEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot()).toMatchObject({
          value: "dictated once",
          cursor: "dictated once".length,
        });
      });
    } finally {
      await screen.unmount();
    }
  });

  it("reconciles an IME composition without duplicate text", async () => {
    setIosUserAgent();
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const controlsRef = createRef<EditorHarnessHandle>();
    const screen = await render(
      <EditorHarness controlsRef={controlsRef} editorRef={editorRef} syncControlledCursor />,
    );

    try {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(editor).not.toBeNull();
      editor?.focus();
      editor?.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
      insertNativeComposerText(editor!, "日本語", "insertCompositionText");
      editor?.dispatchEvent(
        new CompositionEvent("compositionend", { data: "日本語", bubbles: true }),
      );

      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot()).toMatchObject({ value: "日本語", cursor: 3 });
        expect(editor?.textContent).toBe("日本語");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("routes text paste and drop through Lexical without duplicate mutations", async () => {
    setIosUserAgent();
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const controlsRef = createRef<EditorHarnessHandle>();
    const screen = await render(
      <EditorHarness
        controlsRef={controlsRef}
        editorRef={editorRef}
        initialValue="start"
        initialCursor={5}
        syncControlledCursor
      />,
    );

    try {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(editor).not.toBeNull();
      editorRef.current?.focusAt(5);

      const pasteEvent = dispatchTextPaste(editor!, " pasted");
      expect(pasteEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot().value).toBe("start pasted");
      });

      const dropEvent = dispatchTextDropBeforeInput(editor!, " dropped");
      expect(dropEvent.defaultPrevented).toBe(true);
      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot()).toMatchObject({
          value: "start pasted dropped",
          cursor: "start pasted dropped".length,
        });
      });
    } finally {
      await screen.unmount();
    }
  });
});
