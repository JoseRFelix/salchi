import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo, useEffect, useRef, useState } from "react";
import {
  GlobeIcon,
  DiffIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FolderTreeIcon,
  GitBranchIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Button } from "../ui/button";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { readLocalApi } from "../../localApi";
import { probeDevServerReachable, type DevServerLink } from "../../devServerLinks";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  sourceControlToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffOpen: boolean;
  sourceControlOpen: boolean;
  devServerLinks: ReadonlyArray<DevServerLink>;
  devServerProbeBrowserHostname: string | null;
  probeDevServerUrl: (url: string) => Promise<boolean>;
  fileExplorerAvailable: boolean;
  fileExplorerOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleFileExplorer: () => void;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
  onToggleSourceControl: () => void;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadTitle,
  activeProjectName,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  sourceControlToggleShortcutLabel,
  gitCwd,
  diffOpen,
  sourceControlOpen,
  devServerLinks,
  devServerProbeBrowserHostname,
  probeDevServerUrl,
  fileExplorerAvailable,
  fileExplorerOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleFileExplorer,
  onToggleTerminal,
  onToggleDiff,
  onToggleSourceControl,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isCompactHeader = useMediaQuery("(max-width: 760px)");
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const isRemoteThread =
    primaryEnvironmentId !== null && activeThreadEnvironmentId !== primaryEnvironmentId;
  const remoteEnvRuntimeLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[activeThreadEnvironmentId]?.descriptor?.label ?? null,
  );
  const remoteEnvSavedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[activeThreadEnvironmentId]?.label ?? null,
  );
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvRuntimeLabel ?? remoteEnvSavedLabel ?? "Remote")
    : null;
  const renderProjectScriptsControl = (inMenu = false) =>
    activeProjectScripts ? (
      <ProjectScriptsControl
        scripts={activeProjectScripts}
        keybindings={keybindings}
        preferredScriptId={preferredScriptId}
        inMenu={inMenu}
        onRunScript={onRunProjectScript}
        onAddScript={onAddProjectScript}
        onUpdateScript={onUpdateProjectScript}
        onDeleteScript={onDeleteProjectScript}
      />
    ) : null;
  const hasProjectScriptsControl = activeProjectScripts !== undefined;
  const hasSourceControl = Boolean(activeProjectName && gitCwd);
  const showCompactOverflowActions = isCompactHeader && hasProjectScriptsControl;

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <div className="flex min-w-0 flex-col justify-center">
          <h2
            className="min-w-0 truncate text-sm font-medium leading-tight text-foreground"
            title={activeThreadTitle}
          >
            {activeThreadTitle}
          </h2>
          {(activeProjectName || threadEnvironmentLabel) && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-tight text-muted-foreground">
              {activeProjectName && (
                <span className="min-w-0 truncate" title={activeProjectName}>
                  {activeProjectName}
                </span>
              )}
              {activeProjectName && threadEnvironmentLabel && (
                <span aria-hidden className="shrink-0 text-muted-foreground/50">
                  •
                </span>
              )}
              {threadEnvironmentLabel && (
                <span className="min-w-0 shrink truncate" title={threadEnvironmentLabel}>
                  {threadEnvironmentLabel}
                </span>
              )}
              {activeProjectName && !isGitRepo && (
                <Badge
                  variant="outline"
                  className="ml-0.5 shrink-0 px-1 py-0 text-[10px] text-amber-700"
                >
                  Git not present
                </Badge>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1.5 @3xl/header-actions:gap-3">
        {!isCompactHeader && renderProjectScriptsControl()}
        {!isCompactHeader && showOpenInPicker && (
          <>
            <OpenInPicker
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={openInCwd}
            />
          </>
        )}
        {isCompactHeader ? (
          <MobileDevServerButton
            browserHostname={devServerProbeBrowserHostname}
            links={devServerLinks}
            probe={probeDevServerUrl}
          />
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={sourceControlOpen}
                onPressedChange={onToggleSourceControl}
                aria-label="Toggle source control"
                variant="outline"
                size="xs"
                disabled={!hasSourceControl}
              >
                <GitBranchIcon className="size-4.5 sm:size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {hasSourceControl
              ? sourceControlToggleShortcutLabel
                ? `Toggle source control (${sourceControlToggleShortcutLabel})`
                : "Toggle source control"
              : "Source control is unavailable until this thread has an active project."}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="outline"
                size="xs"
                disabled={!terminalAvailable}
              >
                <TerminalSquareIcon className="size-4.5 sm:size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!terminalAvailable
              ? "Terminal is unavailable until this thread has an active project."
              : terminalToggleShortcutLabel
                ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                : "Toggle terminal drawer"}
          </TooltipPopup>
        </Tooltip>
        {!isCompactHeader && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={fileExplorerOpen}
                  onPressedChange={onToggleFileExplorer}
                  aria-label="Toggle file explorer"
                  variant="outline"
                  size="xs"
                  disabled={!fileExplorerAvailable}
                >
                  <FolderTreeIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {fileExplorerAvailable
                ? "Toggle file explorer"
                : "File explorer is unavailable until this thread has an active project."}
            </TooltipPopup>
          </Tooltip>
        )}
        {!isCompactHeader && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={diffOpen}
                  onPressedChange={onToggleDiff}
                  aria-label="Toggle diff panel"
                  variant="ghost"
                  size="xs"
                  disabled={!isGitRepo && !diffOpen}
                >
                  <DiffIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {!isGitRepo && !diffOpen
                ? "Diff panel is unavailable because this project is not a git repository."
                : diffToggleShortcutLabel
                  ? `Toggle diff panel (${diffToggleShortcutLabel})`
                  : "Toggle diff panel"}
            </TooltipPopup>
          </Tooltip>
        )}
        {isCompactHeader ? (
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="outline" aria-label="More thread actions" />}
            >
              <EllipsisIcon className="size-4.5 sm:size-4" />
            </MenuTrigger>
            <MenuPopup align="end" side="bottom" className="min-w-48">
              <MenuItem onClick={() => onToggleDiff()} disabled={!isGitRepo && !diffOpen}>
                <DiffIcon aria-hidden="true" className="size-4" />
                Diff
              </MenuItem>
              <MenuItem onClick={() => onToggleFileExplorer()} disabled={!fileExplorerAvailable}>
                <FolderTreeIcon aria-hidden="true" className="size-4" />
                File explorer
              </MenuItem>
              {showCompactOverflowActions ? <MenuSeparator /> : null}
              {showCompactOverflowActions && hasProjectScriptsControl
                ? renderProjectScriptsControl(true)
                : null}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
    </div>
  );
});

const DEV_SERVER_WINDOW_TARGET = "salchi-dev-server-preview";
const DEV_SERVER_PROBE_INITIAL_DELAY_MS = 250;
const DEV_SERVER_PROBE_INTERVAL_MS = 5000;

let activeDevServerWindow: Window | null = null;
type DevServerReachabilityStatus = "checking" | "reachable" | "unreachable";

function shouldUseBrowserDevServerWindow(): boolean {
  return (
    typeof window !== "undefined" &&
    window.desktopBridge === undefined &&
    window.nativeApi === undefined
  );
}

function openBrowserDevServerWindow(url: string): void {
  if (typeof window === "undefined") return;

  if (activeDevServerWindow && !activeDevServerWindow.closed) {
    try {
      activeDevServerWindow.location.href = url;
      activeDevServerWindow.focus();
      return;
    } catch {
      activeDevServerWindow = null;
    }
  }

  const opened = window.open(url, DEV_SERVER_WINDOW_TARGET);
  if (!opened) return;

  activeDevServerWindow = opened;
  try {
    opened.opener = null;
  } catch {
    // Some browser WindowProxy implementations reject opener writes.
  }
  opened.focus();
}

export function __resetDevServerWindowForTests(): void {
  activeDevServerWindow = null;
}

export function openDevServerLink(url: string): void {
  if (shouldUseBrowserDevServerWindow()) {
    openBrowserDevServerWindow(url);
    return;
  }

  void readLocalApi()
    ?.shell.openExternal(url)
    .catch(() => undefined);
}

function reconcileProbeStatuses(
  current: ReadonlyMap<string, DevServerReachabilityStatus>,
  urls: ReadonlyArray<string>,
): ReadonlyMap<string, DevServerReachabilityStatus> {
  let changed = false;
  const allowedUrls = new Set(urls);
  const next = new Map<string, DevServerReachabilityStatus>();

  for (const [url, status] of current) {
    if (allowedUrls.has(url)) {
      next.set(url, status);
    } else {
      changed = true;
    }
  }

  for (const url of urls) {
    if (!next.has(url)) {
      next.set(url, "checking");
      changed = true;
    }
  }

  return changed ? next : current;
}

function useDevServerReachability(
  links: ReadonlyArray<DevServerLink>,
  probe: (url: string) => Promise<boolean>,
  browserHostnameOverride: string | null,
): ReadonlyMap<string, DevServerReachabilityStatus> {
  const [probeStatuses, setProbeStatuses] = useState<
    ReadonlyMap<string, DevServerReachabilityStatus>
  >(() => new Map());
  // Keep the latest probe without retriggering the polling effect when the
  // parent passes a fresh callback identity on each render.
  const probeRef = useRef(probe);
  probeRef.current = probe;
  const urlKey = links.map((link) => link.url).join("\u0000");

  useEffect(() => {
    const urls = urlKey.length > 0 ? [...new Set(urlKey.split("\u0000"))] : [];
    setProbeStatuses((current) => reconcileProbeStatuses(current, urls));

    if (urls.length === 0) {
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const browserHostname =
      browserHostnameOverride ?? (typeof window === "undefined" ? "" : window.location.hostname);

    const updateReachability = (url: string, reachable: boolean) => {
      if (disposed) return;

      setProbeStatuses((current) => {
        if (!current.has(url)) return current;
        const nextStatus: DevServerReachabilityStatus = reachable ? "reachable" : "unreachable";
        if (current.get(url) === nextStatus) return current;

        const next = new Map(current);
        next.set(url, nextStatus);
        return next;
      });
    };

    const probeUrls = () => {
      for (const url of urls) {
        void probeDevServerReachable(url, {
          browserHostname,
          probe: (target) => probeRef.current(target),
        })
          .then((reachable) => updateReachability(url, reachable))
          .catch(() => updateReachability(url, false));
      }
    };

    const scheduleProbe = (delayMs: number) => {
      timer = setTimeout(() => {
        timer = null;
        probeUrls();
        if (!disposed) {
          scheduleProbe(DEV_SERVER_PROBE_INTERVAL_MS);
        }
      }, delayMs);
    };

    scheduleProbe(DEV_SERVER_PROBE_INITIAL_DELAY_MS);

    return () => {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [browserHostnameOverride, urlKey]);

  return probeStatuses;
}

function aggregateProbeStatus(
  links: ReadonlyArray<DevServerLink>,
  probeStatuses: ReadonlyMap<string, DevServerReachabilityStatus>,
): DevServerReachabilityStatus | null {
  if (links.length === 0) return null;
  const statuses = new Set(links.map((link) => probeStatuses.get(link.url) ?? "checking"));
  if (statuses.has("reachable")) return "reachable";
  if (statuses.has("checking")) return "checking";
  return "unreachable";
}

function devServerReachabilityDotClassName(status: DevServerReachabilityStatus): string {
  if (status === "reachable") {
    return "block size-2 shrink-0 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20";
  }
  if (status === "checking") {
    return "block size-2 shrink-0 animate-pulse rounded-full bg-muted-foreground/60";
  }
  return "block size-2 shrink-0 rounded-full bg-muted-foreground/40";
}

function DevServerReachabilityDot({ status }: { readonly status: DevServerReachabilityStatus }) {
  return <span aria-hidden="true" className={devServerReachabilityDotClassName(status)} />;
}

function DevServerBrowserIcon({
  className,
  status,
}: {
  readonly className: string;
  readonly status: DevServerReachabilityStatus | null;
}) {
  return (
    <span className="relative inline-flex">
      <GlobeIcon className={className} />
      {status === "reachable" ? (
        <span
          aria-hidden="true"
          className={`${devServerReachabilityDotClassName(status)} -right-1 -top-1 absolute border border-background`}
        />
      ) : null}
    </span>
  );
}

function MobileDevServerButton({
  browserHostname,
  links,
  probe,
}: {
  readonly browserHostname: string | null;
  readonly links: ReadonlyArray<DevServerLink>;
  readonly probe: (url: string) => Promise<boolean>;
}) {
  const buttonEnabled = shouldEnableDevServerButton(links);
  const [disabledTooltipOpen, setDisabledTooltipOpen] = useState(false);
  const disabledTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probeStatuses = useDevServerReachability(links, probe, browserHostname);
  const headerProbeStatus = aggregateProbeStatus(links, probeStatuses);
  const tooltipLabel = buttonEnabled
    ? links.length === 1
      ? (links[0]?.displayUrl ?? "Open dev server")
      : "Open dev server"
    : "No running dev servers";
  const buttonClassName = buttonEnabled
    ? "shrink-0 text-foreground hover:text-foreground"
    : "shrink-0";
  const iconClassName = buttonEnabled
    ? "size-4.5 text-foreground sm:size-3"
    : "size-4.5 text-muted-foreground opacity-80 sm:size-3.5";

  useEffect(() => {
    if (!buttonEnabled) return;
    if (disabledTooltipTimerRef.current !== null) {
      clearTimeout(disabledTooltipTimerRef.current);
      disabledTooltipTimerRef.current = null;
    }
    setDisabledTooltipOpen(false);
  }, [buttonEnabled]);

  useEffect(
    () => () => {
      if (disabledTooltipTimerRef.current !== null) {
        clearTimeout(disabledTooltipTimerRef.current);
      }
    },
    [],
  );

  const showDisabledTooltip = () => {
    if (buttonEnabled) return;
    setDisabledTooltipOpen(true);

    if (disabledTooltipTimerRef.current !== null) {
      clearTimeout(disabledTooltipTimerRef.current);
    }
    disabledTooltipTimerRef.current = setTimeout(() => {
      disabledTooltipTimerRef.current = null;
      setDisabledTooltipOpen(false);
    }, 1600);
  };

  if (links.length > 1) {
    return (
      <Tooltip>
        <Menu>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    aria-label="Open detected dev server"
                    className={buttonClassName}
                    size="icon-xs"
                    variant="outline"
                  />
                }
              >
                <DevServerBrowserIcon className={iconClassName} status={headerProbeStatus} />
              </MenuTrigger>
            }
          />
          <TooltipPopup side="bottom">{tooltipLabel}</TooltipPopup>
          <MenuPopup align="end" side="bottom" className="min-w-56">
            {links.map((link) => (
              <MenuItem key={link.url} onClick={() => openDevServerLink(link.url)}>
                <DevServerReachabilityDot status={probeStatuses.get(link.url) ?? "checking"} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{link.displayUrl}</span>
                <ExternalLinkIcon
                  aria-hidden="true"
                  className="ml-auto size-3.5 shrink-0 text-muted-foreground opacity-80"
                />
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      </Tooltip>
    );
  }

  const link = links[0] ?? null;
  if (!link) {
    return (
      <Tooltip open={disabledTooltipOpen}>
        <TooltipTrigger
          render={
            <span
              aria-disabled="true"
              aria-label="No running dev servers"
              className="inline-flex shrink-0 cursor-default"
              onFocus={showDisabledTooltip}
              onPointerDown={showDisabledTooltip}
              onPointerEnter={showDisabledTooltip}
              role="button"
              tabIndex={0}
            >
              <Button
                aria-hidden="true"
                className={buttonClassName}
                disabled
                size="icon-xs"
                tabIndex={-1}
                variant="outline"
              >
                <DevServerBrowserIcon className={iconClassName} status={headerProbeStatus} />
              </Button>
            </span>
          }
        />
        <TooltipPopup side="bottom">{tooltipLabel}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={`Open ${link.displayUrl}`}
            className={buttonClassName}
            onClick={() => openDevServerLink(link.url)}
            size="icon-xs"
            variant="outline"
          >
            <DevServerBrowserIcon className={iconClassName} status={headerProbeStatus} />
          </Button>
        }
      />
      <TooltipPopup side="bottom">{tooltipLabel}</TooltipPopup>
    </Tooltip>
  );
}

export function shouldEnableDevServerButton(links: ReadonlyArray<DevServerLink>): boolean {
  return links.length > 0;
}
