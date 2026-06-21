export interface ThreadTitleInput {
  readonly parentThreadId?: string | null;
  readonly subagentNickname?: string | null;
  readonly subagentRole?: string | null;
  readonly title: string;
}

function isGenericSubagentName(value: string): boolean {
  return /^(default|sub-?agent)$/i.test(value);
}

export function normalizeSubagentDisplayName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const withoutPrefix = trimmed.replace(/^subagent:\s*/i, "").trim();
  const rawCandidate = withoutPrefix || trimmed;
  const basename =
    rawCandidate
      .split(/[\\/]/)
      .map((segment) => segment.trim())
      .findLast((segment) => segment.length > 0) ?? rawCandidate;
  const candidate = basename.replace(/\.[^.]+$/, "").trim() || basename;
  if (isGenericSubagentName(candidate)) {
    return null;
  }
  return candidate;
}

export function resolveThreadDisplayTitle(thread: ThreadTitleInput): string {
  if (!thread.parentThreadId) {
    return thread.title;
  }

  const nickname = normalizeSubagentDisplayName(thread.subagentNickname);
  if (nickname) {
    return nickname;
  }

  const role = normalizeSubagentDisplayName(thread.subagentRole);
  if (role) {
    return role;
  }

  const title = thread.title.trim();
  const withoutPrefix = title.replace(/^subagent:\s*/i, "").trim();
  const fallback = withoutPrefix || title;
  return (
    normalizeSubagentDisplayName(title) ??
    (fallback && !isGenericSubagentName(fallback) ? fallback : "Subagent")
  );
}
