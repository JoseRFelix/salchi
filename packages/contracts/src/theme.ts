import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Schemas for the VS Code theme provider. The app maps VS Code themes onto its
 * design tokens (see apps/web/src/themeMapping.ts); these contracts cover the
 * server-side provider that searches and imports themes from the Open VSX
 * registry (https://open-vsx.org).
 */

export const ThemeColorMode = Schema.Literals(["light", "dark"]);
export type ThemeColorMode = typeof ThemeColorMode.Type;

export const ThemeTokenColor = Schema.Struct({
  scope: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  settings: Schema.Struct({
    foreground: Schema.optional(Schema.String),
  }),
});
export type ThemeTokenColor = typeof ThemeTokenColor.Type;

/** A single theme contributed by an extension, normalized for the client. */
export const ImportedTheme = Schema.Struct({
  /** Synthetic stable id: `<namespace>.<name>/<theme label>`. */
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  type: ThemeColorMode,
  /** Workbench color map (`editor.background` -> `#rrggbb[aa]`). */
  colors: Schema.Record(Schema.String, Schema.String),
  /** TextMate token color rules used for previews when workbench colors are sparse. */
  tokenColors: Schema.optional(Schema.Array(ThemeTokenColor)),
});
export type ImportedTheme = typeof ImportedTheme.Type;

// ── Search ────────────────────────────────────────────────────

export const ThemeSortBy = Schema.Literals(["relevance", "downloadCount"]);
export type ThemeSortBy = typeof ThemeSortBy.Type;

export const ThemeSearchInput = Schema.Struct({
  query: Schema.optional(Schema.String),
  /** Page size; the server clamps this to a sane maximum. */
  size: Schema.optional(Schema.Int),
  /** Zero-based Open VSX result offset for category browsing. */
  offset: Schema.optional(Schema.Int),
  /** Overrides the default Open VSX sort order (relevance for queries, downloads otherwise). */
  sortBy: Schema.optional(ThemeSortBy),
});
export type ThemeSearchInput = typeof ThemeSearchInput.Type;

export const ThemeSearchItem = Schema.Struct({
  namespace: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  downloadCount: Schema.optional(Schema.Int),
});
export type ThemeSearchItem = typeof ThemeSearchItem.Type;

export const ThemeSearchResult = Schema.Struct({
  items: Schema.Array(ThemeSearchItem),
  offset: Schema.Int,
  size: Schema.Int,
  totalSize: Schema.Int,
});
export type ThemeSearchResult = typeof ThemeSearchResult.Type;

// ── Preview / Import ───────────────────────────────────────────

export const ThemeImportInput = Schema.Struct({
  namespace: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** Defaults to the latest published version when omitted. */
  version: Schema.optional(TrimmedNonEmptyString),
});
export type ThemeImportInput = typeof ThemeImportInput.Type;

/** A normalized contributed theme returned by preview and import operations. */
export const ThemePreviewTheme = ImportedTheme;
export type ThemePreviewTheme = typeof ThemePreviewTheme.Type;

export const ThemePreviewResult = Schema.Struct({
  namespace: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  themes: Schema.Array(ThemePreviewTheme),
});
export type ThemePreviewResult = typeof ThemePreviewResult.Type;

export const ThemeImportResult = Schema.Struct({
  namespace: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  /** An extension may contribute several themes (e.g. light + dark variants). */
  themes: Schema.Array(ImportedTheme),
});
export type ThemeImportResult = typeof ThemeImportResult.Type;

// ── Errors ────────────────────────────────────────────────────

export class ThemeProviderError extends Schema.TaggedErrorClass<ThemeProviderError>()(
  "ThemeProviderError",
  {
    operation: Schema.Literals(["search", "preview", "import"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Theme provider failed in ${this.operation}: ${this.detail}`;
  }
}
