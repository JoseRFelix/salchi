import type {
  EnvironmentId,
  ProjectListDirectoryEntriesResult,
  ProjectSearchEntriesResult,
} from "@salchi/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureEnvironmentApi } from "~/environmentApi";

export const projectQueryKeys = {
  all: ["projects"] as const,
  searchEntries: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    query: string,
    limit: number,
  ) => ["projects", "search-entries", environmentId ?? null, cwd, query, limit] as const,
  listDirectoryEntries: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    directoryPath: string | null,
    limit: number,
  ) =>
    [
      "projects",
      "list-directory-entries",
      environmentId ?? null,
      cwd,
      directoryPath,
      limit,
    ] as const,
};

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_LIST_DIRECTORY_ENTRIES_LIMIT = 500;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};
const EMPTY_LIST_DIRECTORY_ENTRIES_RESULT: ProjectListDirectoryEntriesResult = {
  entries: [],
  truncated: false,
};

export function projectSearchEntriesQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(input.environmentId, input.cwd, input.query, limit),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Workspace entry search is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.cwd !== null &&
      input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}

export function projectListDirectoryEntriesQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  directoryPath?: string | null;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_LIST_DIRECTORY_ENTRIES_LIMIT;
  const directoryPath = input.directoryPath ?? null;
  return queryOptions({
    queryKey: projectQueryKeys.listDirectoryEntries(
      input.environmentId,
      input.cwd,
      directoryPath,
      limit,
    ),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Workspace entry listing is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.projects.listDirectoryEntries({
        cwd: input.cwd,
        ...(directoryPath ? { directoryPath } : {}),
        limit,
      });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_LIST_DIRECTORY_ENTRIES_RESULT,
  });
}
