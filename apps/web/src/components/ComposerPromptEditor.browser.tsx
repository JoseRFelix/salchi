import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

const IOS_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1";

async function insertNativeComposerText(editor: HTMLElement, data: string): Promise<void> {
  const beforeInputEvent = new InputEvent("beforeinput", {
    data,
    inputType: "insertText",
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
      inputType: "insertText",
      bubbles: true,
    }),
  );

  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function collapseSelectionAtEnd(editor: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Unable to resolve the composer selection.");
  }
  const range = document.createRange();
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let lastTextNode: Text | null = null;
  while (walker.nextNode()) {
    if (walker.currentNode instanceof Text) {
      lastTextNode = walker.currentNode;
    }
  }
  if (lastTextNode) {
    range.setStart(lastTextNode, lastTextNode.length);
    range.collapse(true);
  } else {
    range.selectNodeContents(editor.lastElementChild ?? editor);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
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

  it("keeps streamed dictation chunks ordered while the controlled cursor lags", async () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: IOS_USER_AGENT,
    });
    const editorRef = createRef<ComposerPromptEditorHandle>();

    function Harness() {
      const [value, setValue] = useState("");
      return (
        <ComposerPromptEditor
          value={value}
          cursor={0}
          terminalContexts={[]}
          skills={[]}
          disabled={false}
          placeholder="Ask anything"
          onRemoveTerminalContext={() => undefined}
          onChange={(nextValue) => setValue(nextValue)}
          onPaste={() => undefined}
          editorRef={editorRef}
        />
      );
    }

    const screen = await render(<Harness />);

    try {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(editor).not.toBeNull();
      editor?.focus();

      await insertNativeComposerText(editor!, "Hello ");
      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot()).toMatchObject({ value: "Hello ", cursor: 6 });
      });
      collapseSelectionAtEnd(editor!);
      await insertNativeComposerText(editor!, "from ");
      await vi.waitFor(() => {
        expect(editorRef.current?.readSnapshot()).toMatchObject({
          value: "Hello from ",
          cursor: 11,
        });
      });
      collapseSelectionAtEnd(editor!);
      await insertNativeComposerText(editor!, "dictation");

      await vi.waitFor(() => {
        expect(editor?.textContent).toBe("Hello from dictation");
        expect(editorRef.current?.readSnapshot()).toMatchObject({
          value: "Hello from dictation",
          cursor: "Hello from dictation".length,
        });
      });
    } finally {
      await screen.unmount();
    }
  });
});
