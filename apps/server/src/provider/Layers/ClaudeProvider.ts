import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
  type ServerProviderState,
} from "@salchi/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  createModelCapabilities,
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@salchi/shared/model";
import { compareSemverVersions } from "@salchi/shared/semver";
import { resolveSpawnCommand } from "@salchi/shared/shell";
import {
  query as claudeQuery,
  type AccountInfo as ClaudeAccountInfo,
  type SlashCommand as ClaudeSlashCommand,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  AUTH_PROBE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  extractAuthBoolean,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const PROVIDER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
} as const;
const MINIMUM_CLAUDE_FABLE_5_VERSION = "2.1.170";
const MINIMUM_CLAUDE_OPUS_4_8_VERSION = "2.1.154";
const MINIMUM_CLAUDE_OPUS_4_7_VERSION = "2.1.111";
const VERSION_GATED_MODEL_REQUIREMENTS = [
  {
    slug: "claude-fable-5",
    name: "Claude Fable 5",
    minimumVersion: MINIMUM_CLAUDE_FABLE_5_VERSION,
  },
  {
    slug: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    minimumVersion: MINIMUM_CLAUDE_OPUS_4_8_VERSION,
  },
  {
    slug: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    minimumVersion: MINIMUM_CLAUDE_OPUS_4_7_VERSION,
  },
] as const;
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-fable-5",
    name: "Claude Fable 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
          ],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildBooleanOptionDescriptor({
          id: "thinking",
          label: "Thinking",
        }),
      ],
    }),
  },
];

function getUnsupportedClaudeModelRequirements(version: string | null | undefined) {
  return VERSION_GATED_MODEL_REQUIREMENTS.filter(
    (requirement) => !version || compareSemverVersions(version, requirement.minimumVersion) < 0,
  );
}

function getBuiltInClaudeModelsForVersion(
  version: string | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const unsupportedSlugs = new Set<string>(
    getUnsupportedClaudeModelRequirements(version).map((requirement) => requirement.slug),
  );
  return BUILT_IN_MODELS.filter((model) => !unsupportedSlugs.has(model.slug));
}

function formatClaudeModelUpgradeMessage(version: string | null): string | undefined {
  const newestUnsupportedModel = getUnsupportedClaudeModelRequirements(version)[0];
  if (!newestUnsupportedModel) {
    return undefined;
  }
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for ${newestUnsupportedModel.name}. Upgrade to v${newestUnsupportedModel.minimumVersion} or newer to access it.`;
}

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    DEFAULT_CLAUDE_MODEL_CAPABILITIES
  );
}

export function resolveClaudeEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");
  const value = getProviderOptionCurrentValue(effortDescriptor);
  return typeof value === "string" ? value : undefined;
}

/**
 * Normalize a resolved Claude effort value into one suitable for the Claude
 * CLI's `--effort` flag.
 *
 * Mirrors the mapping used when invoking the Claude Agent SDK
 * ({@link getEffectiveClaudeAgentEffort} in ClaudeAdapter): the Opus 4.7+
 * capability `"xhigh"` is rewritten to the accepted CLI value `"max"`, and
 * `"ultrathink"` is filtered out because it is a prompt-prefix mode rather
 * than a CLI-effort value. Returns `undefined` when no flag should be passed.
 */
export function normalizeClaudeCliEffort(effort: string | null | undefined): string | undefined {
  if (!effort || effort === "ultrathink") {
    return undefined;
  }
  if (effort === "xhigh") {
    return "max";
  }
  return effort;
}

export function resolveClaudeApiModelId(modelSelection: ModelSelection): string {
  switch (getModelSelectionStringOptionValue(modelSelection, "contextWindow")) {
    case "1m":
      return `${modelSelection.model}[1m]`;
    default:
      return modelSelection.model;
  }
}

function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

function parseClaudeAuthStatusFromOutput(result: CommandResult): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: Pick<ServerProviderAuth, "status">;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message:
        "Claude Agent authentication status command is unavailable in this version of Claude.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `claude login`") ||
    lowerOutput.includes("run claude login")
  ) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }

  const trimmedStdout = result.stdout.trim();
  let parsedAuth: boolean | undefined;
  let parsedJson = false;
  if (trimmedStdout.startsWith("{") || trimmedStdout.startsWith("[")) {
    try {
      parsedAuth = extractAuthBoolean(JSON.parse(trimmedStdout) as unknown);
      parsedJson = true;
    } catch {
      // Fall through to the command exit status for non-JSON output.
    }
  }

  if (parsedAuth === true) {
    return { status: "ready", auth: { status: "authenticated" } };
  }
  if (parsedAuth === false) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }
  if (parsedJson) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message:
        "Could not verify Claude authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", auth: { status: "authenticated" } };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    auth: { status: "unknown" },
    message: detail
      ? `Could not verify Claude authentication status. ${detail}`
      : "Could not verify Claude authentication status.",
  };
}

// ── SDK capability probe ────────────────────────────────────────────

const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

type ClaudeCapabilitiesProbe = {
  readonly email: ClaudeAccountInfo["email"];
  readonly organization: ClaudeAccountInfo["organization"];
  readonly subscriptionType: ClaudeAccountInfo["subscriptionType"];
  readonly tokenSource: ClaudeAccountInfo["tokenSource"];
  readonly apiKeySource: ClaudeAccountInfo["apiKeySource"];
  readonly apiProvider: ClaudeAccountInfo["apiProvider"];
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

type ClaudeAuthProbeResult = {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: Pick<ServerProviderAuth, "status">;
  readonly message?: string;
};

function hasClaudeCredentialSource(value: string | undefined): boolean {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return normalized !== undefined && normalized !== "" && normalized !== "none";
}

function claudeCapabilitiesAuthStatus(
  capabilities: ClaudeCapabilitiesProbe,
): ServerProviderAuth["status"] {
  if (capabilities.apiProvider && capabilities.apiProvider !== "firstParty") {
    // Claude Code delegates authentication to the configured cloud provider.
    return "authenticated";
  }

  if (
    capabilities.email ||
    capabilities.organization ||
    capabilities.subscriptionType ||
    hasClaudeCredentialSource(capabilities.tokenSource) ||
    hasClaudeCredentialSource(capabilities.apiKeySource)
  ) {
    return "authenticated";
  }

  if (
    capabilities.apiProvider === "firstParty" &&
    (capabilities.tokenSource?.trim().toLowerCase() === "none" ||
      capabilities.apiKeySource?.trim().toLowerCase() === "none")
  ) {
    return "unauthenticated";
  }

  return "unknown";
}

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * We pass a never-yielding AsyncIterable as the prompt so that no user
 * message is ever written to the subprocess stdin. This means the Claude
 * Code subprocess completes its local initialization IPC (returning
 * account info and slash commands) but never starts an API request to
 * Anthropic. We read the init data and then abort the subprocess.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    return yield* Effect.tryPromise(async () => {
      const q = claudeQuery({
        // Never yield — we only need initialization data, not a conversation.
        // This prevents any prompt from reaching the Anthropic API.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options: {
          persistSession: false,
          pathToClaudeCodeExecutable: claudeSettings.binaryPath,
          abortController: abort,
          settingSources: ["user", "project", "local"],
          allowedTools: [],
          env: claudeEnvironment,
          stderr: () => {},
        },
      });
      const init = await q.initializationResult();
      const account: ClaudeAccountInfo | undefined = init.account;
      return {
        email: account?.email,
        organization: account?.organization,
        subscriptionType: account?.subscriptionType,
        tokenSource: account?.tokenSource,
        apiKeySource: account?.apiKeySource,
        apiProvider: account?.apiProvider,
        slashCommands: parseClaudeInitializationCommands(init.commands),
      } satisfies ClaudeCapabilitiesProbe;
    });
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );
};

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const allModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in Salchi settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(claudeSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
          : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Claude Agent CLI is installed but failed to run. ${detail}`
          : "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const models = providerModelsFromSettings(
    getBuiltInClaudeModelsForVersion(parsedVersion),
    PROVIDER,
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );
  const claudeModelUpgradeMessage = formatClaudeModelUpgradeMessage(parsedVersion);

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  const slashCommands = capabilities?.slashCommands ?? [];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  const sdkAuthStatus = capabilities ? claudeCapabilitiesAuthStatus(capabilities) : "unknown";
  let resolvedAuth: ClaudeAuthProbeResult;
  if (sdkAuthStatus === "authenticated") {
    resolvedAuth = { status: "ready", auth: { status: "authenticated" } };
  } else if (sdkAuthStatus === "unauthenticated") {
    resolvedAuth = {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  } else {
    const authProbe = yield* runClaudeCommand(claudeSettings, ["auth", "status"], environment).pipe(
      Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isSuccess(authProbe) && Option.isSome(authProbe.success)) {
      resolvedAuth = parseClaudeAuthStatusFromOutput(authProbe.success.value);
    } else {
      resolvedAuth = {
        status: "warning",
        auth: { status: "unknown" },
        message:
          Result.isSuccess(authProbe) && Option.isNone(authProbe.success)
            ? "Could not verify Claude authentication status. Timed out while running command."
            : "Could not verify Claude authentication status.",
      };
    }
  }

  if (resolvedAuth.auth.status !== "authenticated") {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      probe: {
        installed: true,
        version: parsedVersion,
        status: resolvedAuth.status,
        auth: resolvedAuth.auth,
        ...(resolvedAuth.message
          ? { message: resolvedAuth.message }
          : claudeModelUpgradeMessage
            ? { message: claudeModelUpgradeMessage }
            : {}),
      },
    });
  }

  const authMetadata = claudeAuthMetadata({
    subscriptionType: capabilities?.subscriptionType,
    authMethod: capabilities?.tokenSource ?? capabilities?.apiKeySource,
  });
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    slashCommands: dedupedSlashCommands,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities?.email ? { email: capabilities.email } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(claudeModelUpgradeMessage ? { message: claudeModelUpgradeMessage } : {}),
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingClaudeProvider = (
  claudeSettings: ClaudeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    );

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in Salchi settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  });

export { probeClaudeCapabilities };
