import * as Schema from "effect/Schema";

import { useLocalStorage } from "./hooks/useLocalStorage";

export const FILE_PREVIEW_WORD_WRAP_STORAGE_KEY = "salchi:file-preview-word-wrap:v1";
export const DEFAULT_FILE_PREVIEW_WORD_WRAP = false;

export function useFilePreviewWordWrapPreference() {
  return useLocalStorage(
    FILE_PREVIEW_WORD_WRAP_STORAGE_KEY,
    DEFAULT_FILE_PREVIEW_WORD_WRAP,
    Schema.Boolean,
  );
}
