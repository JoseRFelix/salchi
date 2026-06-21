import {
  EventId,
  MessageId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";

export const INDEPENDENT_THREAD_TOOL_NAMESPACE = "salchi";
export const INDEPENDENT_THREAD_TOOL_NAME = "create_thread";
export const INDEPENDENT_THREAD_TOOL_METHOD = "salchi/thread/create";
export const INDEPENDENT_THREAD_MCP_SERVER_NAME = "salchi";
export const INDEPENDENT_THREAD_TOOL_RESULT_MARKER = "salchi.thread.independent.created";

export const INDEPENDENT_THREAD_TOOL_ALIASES = [
  INDEPENDENT_THREAD_TOOL_NAME,
  "createThread",
  "create_independent_thread",
  "createIndependentThread",
  "salchi_create_thread",
] as const;

const INDEPENDENT_THREAD_TOOL_ALIAS_SET = new Set<string>(INDEPENDENT_THREAD_TOOL_ALIASES);

export type IndependentThreadToolArguments = {
  readonly requestedThreadId?: ThreadId;
  readonly title: string;
  readonly initialPrompt?: string;
  readonly titleSeed?: string;
  readonly checkoutMode?: "inherit" | "local" | "worktree";
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
};

export type ProviderDynamicToolSpec = {
  readonly deferLoading?: boolean;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly name: string;
  readonly namespace?: string | null;
};

export type IndependentThreadToolRuntimeResult = {
  readonly payload: Extract<
    ProviderRuntimeEvent,
    { readonly type: "thread.independent.created" }
  >["payload"];
  readonly text: string;
  readonly structuredContent: {
    readonly type: typeof INDEPENDENT_THREAD_TOOL_RESULT_MARKER;
    readonly version: 1;
    readonly payload: IndependentThreadToolRuntimeResult["payload"];
  };
};

export const INDEPENDENT_THREAD_TOOL_DESCRIPTION =
  "Create a new independent top-level Salchi thread with its own provider session. This is not a subagent or child thread.";

export const INDEPENDENT_THREAD_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: {
      type: "string",
      minLength: 1,
      description: "Concise title for the independent thread.",
    },
    initialPrompt: {
      type: "string",
      minLength: 1,
      description:
        "First user-style prompt to run in the new thread. Include enough context for the thread to work independently.",
    },
    titleSeed: {
      type: "string",
      minLength: 1,
      description: "Optional short source text for title generation.",
    },
    checkoutMode: {
      type: "string",
      enum: ["inherit", "local", "worktree"],
      description:
        "Optional checkout placement. Use 'inherit' to reuse the source thread checkout, 'local' to run in the project workspace root, or 'worktree' to run in a specific worktreePath.",
    },
    branch: {
      type: ["string", "null"],
      minLength: 1,
      description:
        "Optional branch label for the new thread. Use null when switching checkouts and the branch is unknown.",
    },
    worktreePath: {
      type: ["string", "null"],
      minLength: 1,
      description:
        "Optional absolute path for a dedicated worktree or checkout. Use null with checkoutMode 'local' to force the project workspace root.",
    },
    threadId: {
      type: "string",
      minLength: 1,
      description: "Optional stable Salchi thread id when one was supplied by the client.",
    },
  },
  required: ["title", "initialPrompt"],
} as const;

export const INDEPENDENT_THREAD_TOOL_SPEC = {
  name: INDEPENDENT_THREAD_TOOL_NAME,
  namespace: INDEPENDENT_THREAD_TOOL_NAMESPACE,
  description: INDEPENDENT_THREAD_TOOL_DESCRIPTION,
  inputSchema: INDEPENDENT_THREAD_TOOL_INPUT_SCHEMA,
} as const satisfies ProviderDynamicToolSpec;

export const INDEPENDENT_THREAD_TOOL_MCP_INSTRUCTIONS =
  "Use create_thread when the user asks to start a separate independent Salchi thread. This creates a root Salchi thread, not a subagent or child thread.";

export const INDEPENDENT_THREAD_TOOL_CODEX_INSTRUCTIONS = `## create_thread availability

The dynamic tool \`create_thread\` is available in namespace \`salchi\`.

Use it when the user asks you to start another independent thread, split work into a separate thread, launch parallel investigation or implementation work, or preserve the current conversation while opening a separate work stream.

This creates an independent top-level Salchi thread with its own provider session. It is not a subagent, not a child thread, and not part of the current thread's execution tree.

Arguments:

* \`title\` (string, required): concise title for the new thread.
* \`initialPrompt\` (string, required): first user-style prompt for the new thread. Include enough context for that thread to proceed independently.
* \`titleSeed\` (string, optional): short source text for title generation when useful.
* \`checkoutMode\` ("inherit" | "local" | "worktree", optional): use "inherit" or omit it to reuse this thread's checkout, use "local" to start in the project workspace root, or use "worktree" with \`worktreePath\` to start in a specific worktree.
* \`branch\` (string | null, optional): branch label for the new thread. Include it when known; use null if switching checkouts and the branch is unknown.
* \`worktreePath\` (string | null, optional): absolute path for a dedicated worktree or checkout. Set null with \`checkoutMode: "local"\` to force the project workspace root.
* \`threadId\` (string, optional): stable id only when the client already provided one.

After the tool returns success, continue the current thread normally unless the user asked you to stop.`;

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readStringField(
  record: Record<string, unknown>,
  fieldNames: ReadonlyArray<string>,
): string | undefined {
  for (const fieldName of fieldNames) {
    const raw = record[fieldName];
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function readNullableStringField(
  record: Record<string, unknown>,
  fieldNames: ReadonlyArray<string>,
): { readonly specified: boolean; readonly value?: string | null } {
  for (const fieldName of fieldNames) {
    if (!Object.hasOwn(record, fieldName)) {
      continue;
    }
    const raw = record[fieldName];
    if (raw === null) {
      return { specified: true, value: null };
    }
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return { specified: true, value: trimmed };
    }
  }
  return { specified: false };
}

function readCheckoutMode(
  record: Record<string, unknown>,
): IndependentThreadToolArguments["checkoutMode"] {
  const raw = readStringField(record, ["checkoutMode", "checkout"]);
  switch (raw?.toLowerCase().replace(/[-_\s]+/g, "")) {
    case "inherit":
      return "inherit";
    case "local":
    case "localcheckout":
    case "workspace":
    case "workspaceroot":
      return "local";
    case "worktree":
      return "worktree";
    default:
      return undefined;
  }
}

function titleFromPrompt(prompt: string | undefined): string | undefined {
  if (!prompt) {
    return undefined;
  }
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  if (!singleLine) {
    return undefined;
  }
  return singleLine.length <= 80 ? singleLine : `${singleLine.slice(0, 77)}...`;
}

export function isIndependentThreadToolCall(input: {
  readonly namespace?: string | null;
  readonly tool: string;
}): boolean {
  const namespace = input.namespace?.trim();
  const tool = input.tool.trim();
  return (
    (!namespace || namespace === INDEPENDENT_THREAD_TOOL_NAMESPACE) &&
    INDEPENDENT_THREAD_TOOL_ALIAS_SET.has(tool)
  );
}

export function parseIndependentThreadToolArguments(
  argumentsValue: unknown,
): IndependentThreadToolArguments {
  const record = asPlainRecord(argumentsValue) ?? {};
  const initialPrompt = readStringField(record, ["initialPrompt", "prompt", "input", "message"]);
  const title =
    readStringField(record, ["title", "name"]) ??
    titleFromPrompt(initialPrompt) ??
    "Created thread";
  const titleSeed = readStringField(record, ["titleSeed"]);
  const requestedThreadId = readStringField(record, ["threadId"]);
  const checkoutMode = readCheckoutMode(record);
  const branch = readNullableStringField(record, ["branch", "branchName"]);
  const worktreePath = readNullableStringField(record, [
    "worktreePath",
    "worktree",
    "checkoutPath",
    "cwd",
  ]);
  const resolvedWorktreePath =
    checkoutMode === "local"
      ? null
      : worktreePath.specified
        ? (worktreePath.value ?? null)
        : undefined;
  const checkoutChanged =
    worktreePath.specified || checkoutMode === "local" || checkoutMode === "worktree";
  const resolvedBranch = branch.specified
    ? (branch.value ?? null)
    : checkoutChanged
      ? null
      : undefined;
  return {
    ...(requestedThreadId ? { requestedThreadId: ThreadId.make(requestedThreadId) } : {}),
    title,
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(titleSeed ? { titleSeed } : {}),
    ...(checkoutMode ? { checkoutMode } : {}),
    ...(resolvedBranch !== undefined ? { branch: resolvedBranch } : {}),
    ...(resolvedWorktreePath !== undefined ? { worktreePath: resolvedWorktreePath } : {}),
  };
}

export function createIndependentThreadToolRuntimeResult(input: {
  readonly argumentsValue: unknown;
  readonly sourceThreadId: ThreadId;
  readonly idPrefix: string;
  readonly sourceItemId?: RuntimeItemId | string;
  readonly providerThreadId?: string;
}): IndependentThreadToolRuntimeResult {
  const parsedArguments = parseIndependentThreadToolArguments(input.argumentsValue);
  const sourceItemId =
    typeof input.sourceItemId === "string"
      ? RuntimeItemId.make(input.sourceItemId)
      : input.sourceItemId;
  const threadId =
    parsedArguments.requestedThreadId ?? ThreadId.make(`${input.idPrefix}:independent-thread`);
  const initialMessageId = MessageId.make(`${input.idPrefix}:initial-message`);
  const payload: IndependentThreadToolRuntimeResult["payload"] = {
    threadId,
    title: parsedArguments.title,
    createdByThreadId: input.sourceThreadId,
    initialMessageId,
    ...(sourceItemId ? { sourceItemId } : {}),
    ...(input.providerThreadId ? { providerThreadId: input.providerThreadId } : {}),
    ...(parsedArguments.initialPrompt ? { initialPrompt: parsedArguments.initialPrompt } : {}),
    ...(parsedArguments.titleSeed ? { titleSeed: parsedArguments.titleSeed } : {}),
    ...(parsedArguments.branch !== undefined ? { branch: parsedArguments.branch } : {}),
    ...(parsedArguments.worktreePath !== undefined
      ? { worktreePath: parsedArguments.worktreePath }
      : {}),
  };

  return {
    payload,
    text: `Created independent thread '${payload.threadId}' (${payload.title}) from '${input.sourceThreadId}'.`,
    structuredContent: {
      type: INDEPENDENT_THREAD_TOOL_RESULT_MARKER,
      version: 1,
      payload,
    },
  };
}

export function makeIndependentThreadCreatedRuntimeEvent(input: {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly eventId: EventId;
  readonly createdAt: string;
  readonly sourceThreadId: ThreadId;
  readonly turnId?: TurnId;
  readonly idPrefix: string;
  readonly argumentsValue: unknown;
  readonly sourceItemId?: RuntimeItemId | string;
  readonly providerThreadId?: string;
  readonly raw?: ProviderRuntimeEvent["raw"];
  readonly providerRefs?: ProviderRuntimeEvent["providerRefs"];
}): ProviderRuntimeEvent {
  const result = createIndependentThreadToolRuntimeResult({
    argumentsValue: input.argumentsValue,
    sourceThreadId: input.sourceThreadId,
    idPrefix: input.idPrefix,
    ...(input.sourceItemId ? { sourceItemId: input.sourceItemId } : {}),
    ...(input.providerThreadId ? { providerThreadId: input.providerThreadId } : {}),
  });

  return {
    type: "thread.independent.created",
    eventId: input.eventId,
    provider: input.provider,
    ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
    createdAt: input.createdAt,
    threadId: input.sourceThreadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(result.payload.sourceItemId ? { itemId: result.payload.sourceItemId } : {}),
    payload: result.payload,
    ...(input.providerRefs ? { providerRefs: input.providerRefs } : {}),
    ...(input.raw ? { raw: input.raw } : {}),
  };
}
