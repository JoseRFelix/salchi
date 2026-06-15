"use client";

/* oxlint-disable react/iframe-missing-sandbox -- Neko's WebRTC client needs scripts and same-origin in the embedded app. */
import type { RemoteBrowserScreen } from "@t3tools/contracts";
import { ArrowRight, MonitorSmartphone, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Button } from "~/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { ensureLocalApi } from "~/localApi";
import { useRemoteBrowserStatus } from "~/rpc/serverState";

const localApi = typeof window === "undefined" ? null : ensureLocalApi();

const screenPresets: ReadonlyArray<{
  readonly label: string;
  readonly value: RemoteBrowserScreen;
}> = [
  { label: "390x844", value: "390x844@30" },
  { label: "430x932", value: "430x932@30" },
  { label: "768x1024", value: "768x1024@30" },
  { label: "1280x720", value: "1280x720@30" },
  { label: "1440x900", value: "1440x900@30" },
  { label: "1920x1080", value: "1920x1080@30" },
];

const clampScreenDimension = (value: number): number => Math.max(320, Math.min(1920, value));

const screenLabel = (screen: RemoteBrowserScreen, fitScreen: RemoteBrowserScreen | null): string =>
  fitScreen === screen
    ? "Fit"
    : (screenPresets.find((preset) => preset.value === screen)?.label ??
      screen.replace(/@.*$/u, ""));

function statusTitle(state: ReturnType<typeof useRemoteBrowserStatus>["state"]): string {
  switch (state) {
    case "disabled":
      return "Remote browser disabled";
    case "idle":
      return "Remote browser ready to start";
    case "checking-docker":
      return "Checking Docker";
    case "pulling-image":
      return "Downloading browser image";
    case "starting-container":
      return "Starting browser";
    case "ready":
      return "Remote browser ready";
    case "error":
      return "Remote browser error";
  }
}

export function RemoteBrowserPanel() {
  const status = useRemoteBrowserStatus();
  const [starting, setStarting] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [addressValue, setAddressValue] = useState(status.pageUrl ?? "");
  const [frameSize, setFrameSize] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const [iframeVisible, setIframeVisible] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const revealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canStart =
    status.enabled &&
    (status.state === "idle" || status.state === "error" || status.state === "disabled") &&
    !starting;
  const canNavigate =
    status.state === "ready" && status.agentControl.state === "ready" && !starting && !navigating;

  const start = useCallback(() => {
    if (!localApi) return;
    setStarting(true);
    void localApi.server.startRemoteBrowser().finally(() => setStarting(false));
  }, []);

  const revealIframeAfter = useCallback((delayMs: number) => {
    if (revealTimeoutRef.current !== null) clearTimeout(revealTimeoutRef.current);
    revealTimeoutRef.current = setTimeout(() => {
      setIframeVisible(true);
      revealTimeoutRef.current = null;
    }, delayMs);
  }, []);

  const changeScreen = useCallback(
    (screen: string | null) => {
      if (!localApi || screen === null || screen === status.screen) return;
      setIframeVisible(false);
      setStarting(true);
      void localApi.server
        .startRemoteBrowser({ screen: screen as RemoteBrowserScreen })
        .finally(() => {
          setStarting(false);
          revealIframeAfter(1800);
        });
    },
    [revealIframeAfter, status.screen],
  );

  const navigateToAddress = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!localApi || !canNavigate) return;
      const url = addressValue.trim();
      if (url.length === 0) return;
      setNavigating(true);
      void localApi.server.navigateRemoteBrowser({ url }).finally(() => setNavigating(false));
    },
    [addressValue, canNavigate],
  );

  const fitScreen = useMemo<RemoteBrowserScreen | null>(() => {
    if (!frameSize) return null;
    const pixelRatio =
      typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const width = clampScreenDimension(Math.round(frameSize.width * pixelRatio));
    const height = clampScreenDimension(Math.round(frameSize.height * pixelRatio));
    return `${width}x${height}@30` as RemoteBrowserScreen;
  }, [frameSize]);

  const screenItems = useMemo(
    () => [
      ...(fitScreen ? [{ label: "Fit", value: fitScreen }] : []),
      ...screenPresets.filter((preset) => preset.value !== fitScreen),
      ...(fitScreen === null ||
      fitScreen === status.screen ||
      screenPresets.some((preset) => preset.value === status.screen)
        ? []
        : [{ label: screenLabel(status.screen, fitScreen), value: status.screen }]),
    ],
    [fitScreen, status.screen],
  );

  useEffect(() => {
    const node = frameRef.current;
    if (!node || status.state !== "ready") return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setFrameSize({
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(0, Math.floor(rect.height)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [status.state]);

  useEffect(() => {
    setIframeVisible(false);
    if (revealTimeoutRef.current !== null) {
      clearTimeout(revealTimeoutRef.current);
      revealTimeoutRef.current = null;
    }
  }, [status.url]);

  useEffect(
    () => () => {
      if (revealTimeoutRef.current !== null) clearTimeout(revealTimeoutRef.current);
    },
    [],
  );

  const revealIframe = useCallback(() => {
    revealIframeAfter(4000);
  }, [revealIframeAfter]);

  useEffect(() => {
    if (status.enabled && status.state === "idle") {
      start();
    }
  }, [start, status.enabled, status.state]);

  useEffect(() => {
    if (!navigating) setAddressValue(status.pageUrl ?? "");
  }, [navigating, status.pageUrl]);

  if (status.state === "ready" && status.url) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-3">
          <div className="hidden min-w-0 shrink-0 text-xs text-muted-foreground sm:block">
            <span className="font-medium text-foreground">Remote Browser</span>
            {status.agentControl.state === "ready" ? (
              <span className="ml-2 hidden sm:inline">Agent control ready</span>
            ) : status.cdpUrl ? (
              <span className="ml-2 hidden sm:inline">
                Agent control {status.agentControl.state}
                {status.agentControl.message ? `: ${status.agentControl.message}` : ""}
              </span>
            ) : null}
          </div>
          <form className="flex min-w-0 flex-1 items-center gap-1.5" onSubmit={navigateToAddress}>
            <Input
              nativeInput
              size="sm"
              type="text"
              value={addressValue}
              placeholder={
                status.agentControl.state === "ready" ? "Enter URL" : "Waiting for browser control"
              }
              disabled={status.agentControl.state !== "ready"}
              className="min-w-0 flex-1 rounded-md"
              onChange={(event) => setAddressValue(event.currentTarget.value)}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              type="submit"
              disabled={!canNavigate || addressValue.trim().length === 0}
              aria-label="Go"
            >
              {navigating ? (
                <RefreshCw className="size-3.5 animate-spin" />
              ) : (
                <ArrowRight className="size-3.5" />
              )}
            </Button>
          </form>
          <div className="flex shrink-0 items-center gap-1.5">
            {status.provider === "managed-neko" ? (
              <Select
                modal={false}
                value={status.screen}
                onValueChange={changeScreen}
                items={screenItems}
                disabled={starting}
              >
                <SelectTrigger
                  variant="ghost"
                  size="xs"
                  className="w-28 font-medium"
                  aria-label="Remote browser resolution"
                >
                  <MonitorSmartphone className="size-3.5" />
                  <SelectValue>{screenLabel(status.screen, fitScreen)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectGroup>
                    <SelectGroupLabel>Resolution</SelectGroupLabel>
                    {screenItems.map((preset) => (
                      <SelectItem key={preset.value} value={preset.value}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectPopup>
              </Select>
            ) : null}
          </div>
        </div>
        <div ref={frameRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
          <iframe
            key={status.url}
            title="Remote browser"
            src={status.url}
            className="absolute inset-0 size-full border-0 bg-background"
            allow="clipboard-read; clipboard-write; fullscreen; microphone; camera; autoplay"
            sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"
            onLoad={revealIframe}
          />
          {!iframeVisible ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background">
              <RefreshCw className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <Alert variant={status.state === "error" ? "error" : "info"} className="w-full max-w-md">
        <RefreshCw
          className={
            status.state === "checking-docker" ||
            status.state === "pulling-image" ||
            status.state === "starting-container" ||
            starting
              ? "animate-spin"
              : undefined
          }
        />
        <AlertTitle>{statusTitle(status.state)}</AlertTitle>
        <AlertDescription>
          <span>{status.message ?? "Preparing the remote browser."}</span>
          {status.image ? <span className="text-xs">Image: {status.image}</span> : null}
          {status.containerName ? (
            <span className="text-xs">Container: {status.containerName}</span>
          ) : null}
          <span className="text-xs">Resolution: {screenLabel(status.screen, fitScreen)}</span>
        </AlertDescription>
        {canStart ? (
          <div data-slot="alert-action">
            <Button variant="outline" size="sm" type="button" onClick={start}>
              Start
            </Button>
          </div>
        ) : null}
      </Alert>
    </div>
  );
}
