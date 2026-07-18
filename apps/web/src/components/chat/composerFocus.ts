import type { PointerEventHandler } from "react";

export const preserveComposerFocusOnPointerDown: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};
