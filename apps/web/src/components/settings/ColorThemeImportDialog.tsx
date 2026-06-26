import { DownloadIcon, SearchIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import {
  importedThemeRecordsFromImportResult,
  saveImportedThemes,
  type ImportedThemeRecord,
} from "../../importedThemes";
import type { ThemeSearchItem } from "@t3tools/contracts";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

interface ColorThemeImportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Called with the imported records so callers can sync references + select. */
  readonly onImported: (records: ReadonlyArray<ImportedThemeRecord>) => void;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "detail" in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return error instanceof Error ? error.message : fallback;
}

export function ColorThemeImportDialog({
  open,
  onOpenChange,
  onImported,
}: ColorThemeImportDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<ThemeSearchItem>>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    setIsSearching(true);
    setSearched(true);
    try {
      const result = await ensureLocalApi().themes.search({ query: trimmed });
      setResults(result.items);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Theme search failed",
        description: errorMessage(error, "Could not reach the Open VSX registry."),
      });
    } finally {
      setIsSearching(false);
    }
  }, [query]);

  const importTheme = useCallback(
    async (item: ThemeSearchItem) => {
      const key = `${item.namespace}.${item.name}`;
      setImportingId(key);
      try {
        const result = await ensureLocalApi().themes.import({
          namespace: item.namespace,
          name: item.name,
          version: item.version,
        });
        const records = importedThemeRecordsFromImportResult(result);
        saveImportedThemes(records);
        onImported(records);
        toastManager.add({
          type: "success",
          title: `Imported ${item.displayName}`,
          description:
            records.length > 1
              ? `Added ${records.length} themes to your picker.`
              : "Added to your theme picker.",
        });
        onOpenChange(false);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Import failed",
          description: errorMessage(error, "Could not import this theme."),
        });
      } finally {
        setImportingId(null);
      }
    },
    [onImported, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Import a VS Code theme</DialogTitle>
          <DialogDescription>
            Search the Open VSX registry and import any theme extension. Imported themes appear in
            the light/dark theme pickers.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex items-center gap-2 px-6"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search themes (e.g. Catppuccin, Dracula, Night Owl)"
            aria-label="Theme search query"
          />
          <Button type="submit" variant="secondary" disabled={isSearching || query.trim() === ""}>
            {isSearching ? <Spinner /> : <SearchIcon className="size-4" />}
            Search
          </Button>
        </form>

        <div className="mt-3 max-h-80 overflow-y-auto px-6 pb-2">
          {isSearching ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Searching Open VSX…</p>
          ) : results.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {searched ? "No themes matched your search." : "Search to find themes to import."}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {results.map((item) => {
                const key = `${item.namespace}.${item.name}`;
                return (
                  <li
                    key={key}
                    className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-accent"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{item.displayName}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {item.namespace} ·{" "}
                        {item.description?.trim() || `${item.name}@${item.version}`}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={importingId !== null}
                      onClick={() => void importTheme(item)}
                    >
                      {importingId === key ? <Spinner /> : <DownloadIcon className="size-4" />}
                      Import
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="border-t bg-background">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
