import type {
  EnvironmentId,
  SourceControlCloneProtocol,
  SourceControlProviderDiscoveryItem,
  SourceControlProviderKind,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryVisibility,
} from "@salchi/contracts";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { CheckIcon, ChevronDownIcon, ExternalLinkIcon, GlobeIcon, LockIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";

import { AnimatedHeight } from "./AnimatedHeight";
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon } from "~/components/Icons";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { RadioGroup } from "~/components/ui/radio-group";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { refreshGitStatus } from "~/lib/gitStatusState";
import { useSourceControlDiscovery } from "~/lib/sourceControlDiscoveryState";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { sourceControlPublishRepositoryMutationOptions } from "~/lib/gitReactQuery";

type PublishProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "bitbucket" | "azure-devops"
>;

const PUBLISH_PROVIDER_OPTIONS = [
  {
    value: "github",
    label: "GitHub",
    description: "github.com",
    host: "github.com",
    pathPlaceholder: "owner/repo",
    Icon: GitHubIcon,
  },
  {
    value: "gitlab",
    label: "GitLab",
    description: "gitlab.com",
    host: "gitlab.com",
    pathPlaceholder: "group/project",
    Icon: GitLabIcon,
  },
  {
    value: "bitbucket",
    label: "Bitbucket",
    description: "bitbucket.org",
    host: "bitbucket.org",
    pathPlaceholder: "workspace/repository",
    Icon: BitbucketIcon,
  },
  {
    value: "azure-devops",
    label: "Azure DevOps",
    description: "dev.azure.com",
    host: "dev.azure.com",
    pathPlaceholder: "project/repository",
    Icon: AzureDevOpsIcon,
  },
] as const satisfies ReadonlyArray<{
  readonly value: PublishProviderKind;
  readonly label: string;
  readonly description: string;
  readonly host: string;
  readonly pathPlaceholder: string;
  readonly Icon: typeof GitHubIcon;
}>;

function publishProviderOption(provider: PublishProviderKind) {
  return (
    PUBLISH_PROVIDER_OPTIONS.find((option) => option.value === provider) ??
    PUBLISH_PROVIDER_OPTIONS[0]
  );
}

function isPublishProviderKind(
  provider: SourceControlProviderKind,
): provider is PublishProviderKind {
  return PUBLISH_PROVIDER_OPTIONS.some((option) => option.value === provider);
}

function getPublishProviderReadiness(input: {
  provider: PublishProviderKind;
  sourceControlProviders: ReadonlyArray<SourceControlProviderDiscoveryItem>;
}): { readonly ready: boolean; readonly hint: string | null } {
  const discovered = input.sourceControlProviders.find(
    (provider) => provider.kind === input.provider,
  );
  if (!discovered) {
    return {
      ready: false,
      hint: "Provider status unavailable. Open Settings -> Source Control and rescan.",
    };
  }
  if (discovered.status !== "available") {
    return { ready: false, hint: discovered.installHint };
  }
  if (discovered.auth.status === "unauthenticated") {
    return {
      ready: false,
      hint:
        Option.getOrNull(discovered.auth.detail) ??
        `${discovered.label} is not authenticated. Open Settings -> Source Control for setup guidance.`,
    };
  }
  return { ready: true, hint: null };
}

export interface SourceControlPublishDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId | null;
  readonly gitCwd: string;
}

export function SourceControlPublishDialog(props: SourceControlPublishDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const sourceControlDiscovery = useSourceControlDiscovery();
  const [publishProvider, setPublishProvider] = useState<PublishProviderKind>("github");
  const [publishRepository, setPublishRepository] = useState("");
  const [publishVisibility, setPublishVisibility] =
    useState<SourceControlRepositoryVisibility>("private");
  const [publishRemoteName, setPublishRemoteName] = useState("origin");
  const [publishProtocol, setPublishProtocol] = useState<SourceControlCloneProtocol>("ssh");
  const [publishWizardStep, setPublishWizardStep] = useState(0);
  const [publishAdvancedOpen, setPublishAdvancedOpen] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<SourceControlPublishRepositoryResult | null>(
    null,
  );
  const [hasUserEditedPublishRepository, setHasUserEditedPublishRepository] = useState(false);
  const publishRepositoryMutation = useMutation(
    sourceControlPublishRepositoryMutationOptions({
      environmentId: props.environmentId,
      cwd: props.gitCwd,
      queryClient,
    }),
  );
  const publishAccountByProvider = useMemo(() => {
    const accounts: Record<PublishProviderKind, string | null> = {
      github: null,
      gitlab: null,
      bitbucket: null,
      "azure-devops": null,
    };
    for (const provider of sourceControlDiscovery.data?.sourceControlProviders ?? []) {
      if (isPublishProviderKind(provider.kind)) {
        accounts[provider.kind] = Option.getOrNull(provider.auth.account);
      }
    }
    return accounts;
  }, [sourceControlDiscovery.data]);
  const publishProviderReadiness = useMemo(() => {
    const sourceControlProviders = sourceControlDiscovery.data?.sourceControlProviders ?? [];
    return Object.fromEntries(
      PUBLISH_PROVIDER_OPTIONS.map((option) => [
        option.value,
        getPublishProviderReadiness({
          provider: option.value,
          sourceControlProviders,
        }),
      ]),
    ) as Record<PublishProviderKind, { readonly ready: boolean; readonly hint: string | null }>;
  }, [sourceControlDiscovery.data]);
  const hasReadyPublishProvider = useMemo(
    () => PUBLISH_PROVIDER_OPTIONS.some((option) => publishProviderReadiness[option.value].ready),
    [publishProviderReadiness],
  );
  const sortedPublishProviderOptions = useMemo(
    () =>
      PUBLISH_PROVIDER_OPTIONS.toSorted((left, right) => {
        const leftReady = publishProviderReadiness[left.value].ready;
        const rightReady = publishProviderReadiness[right.value].ready;
        if (leftReady !== rightReady) {
          return leftReady ? -1 : 1;
        }
        return left.label.localeCompare(right.label);
      }),
    [publishProviderReadiness],
  );
  const selectedPublishProviderReadiness = publishProviderReadiness[publishProvider];
  const publishRepositoryPrefill = publishAccountByProvider[publishProvider]
    ? `${publishAccountByProvider[publishProvider]}/`
    : "";
  const currentPublishProvider = publishProviderOption(publishProvider);
  const publishHost = currentPublishProvider.host;
  const publishPathPlaceholder = currentPublishProvider.pathPlaceholder;
  const publishProviderLabel = currentPublishProvider.label;
  const publishWizardSteps = ["Provider", "Repository", "Summary"] as const;
  const publishWizardStepSummaries = [
    publishProviderLabel,
    publishResult?.repository.nameWithOwner ?? null,
    null,
  ] as const;

  useEffect(() => {
    if (!props.open || hasUserEditedPublishRepository) {
      return;
    }
    setPublishRepository(publishRepositoryPrefill);
  }, [hasUserEditedPublishRepository, props.open, publishRepositoryPrefill]);

  const canSubmitPublishRepository = useMemo(() => {
    if (!selectedPublishProviderReadiness.ready) return false;
    if (publishRepositoryMutation.isPending) return false;
    const repositoryParts = publishRepository.trim().split("/");
    const owner = repositoryParts[0]?.trim() ?? "";
    const rest = repositoryParts.slice(1);
    const name = rest.join("/").trim();
    return owner.length > 0 && name.length > 0;
  }, [publishRepository, publishRepositoryMutation.isPending, selectedPublishProviderReadiness]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    if (publishProviderReadiness[publishProvider].ready) {
      return;
    }
    const firstReadyProvider = PUBLISH_PROVIDER_OPTIONS.find(
      (option) => publishProviderReadiness[option.value].ready,
    );
    if (firstReadyProvider) {
      setPublishProvider(firstReadyProvider.value);
    }
  }, [props.open, publishProvider, publishProviderReadiness]);

  const submitPublishRepository = useCallback(() => {
    if (!canSubmitPublishRepository) {
      return;
    }

    setPublishError(null);

    void publishRepositoryMutation
      .mutateAsync({
        provider: publishProvider,
        repository: publishRepository.trim(),
        visibility: publishVisibility,
        remoteName: publishRemoteName.trim() || "origin",
        protocol: publishProtocol,
      })
      .then((result) => {
        flushSync(() => {
          setPublishResult(result);
          setPublishWizardStep(2);
        });
        void refreshGitStatus({ environmentId: props.environmentId, cwd: props.gitCwd }).catch(
          () => undefined,
        );
      })
      .catch((err: unknown) => {
        setPublishError(err instanceof Error ? err.message : "An error occurred.");
      });
  }, [
    canSubmitPublishRepository,
    props.environmentId,
    props.gitCwd,
    publishProtocol,
    publishProvider,
    publishRemoteName,
    publishRepository,
    publishRepositoryMutation,
    publishVisibility,
  ]);

  const resetState = useCallback(() => {
    setPublishRemoteName("origin");
    setPublishRepository("");
    setHasUserEditedPublishRepository(false);
    setPublishWizardStep(0);
    setPublishAdvancedOpen(false);
    setPublishError(null);
    setPublishResult(null);
  }, []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      props.onOpenChange(open);
      if (!open) {
        resetState();
      }
    },
    [props, resetState],
  );

  const openSourceControlSettings = useCallback(() => {
    handleOpenChange(false);
    void navigate({ to: "/settings/source-control" });
  }, [handleOpenChange, navigate]);

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-xl overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden border-foreground/10 bg-background shadow-2xl">
          <DialogHeader className="border-b border-border/70 bg-background">
            <DialogTitle>Publish repository</DialogTitle>
            <DialogDescription>
              Pick where to host it, then point us at a repo to push to.
            </DialogDescription>
            <div className="grid grid-cols-3 gap-2">
              {publishWizardSteps.map((label, index) => {
                const isComplete = index < publishWizardStep;
                const isClickable =
                  publishWizardStep !== 2 &&
                  index < publishWizardSteps.length - 1 &&
                  index <= publishWizardStep;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={isClickable ? () => setPublishWizardStep(index) : undefined}
                    disabled={!isClickable}
                    className={cn(
                      "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-lg border px-3 py-2 text-left",
                      index === publishWizardStep
                        ? "border-primary bg-primary/10 ring-1 ring-primary/25"
                        : isComplete
                          ? "border-border bg-background"
                          : "border-border bg-muted/40",
                      !isClickable && "cursor-default",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "row-span-2 mt-0.5 grid size-4 place-items-center rounded-full border",
                        isComplete
                          ? "border-primary bg-primary text-primary-foreground"
                          : index === publishWizardStep
                            ? "border-primary bg-background"
                            : "border-muted-foreground/35 bg-background",
                      )}
                    >
                      {isComplete ? <CheckIcon className="size-3" /> : null}
                    </span>
                    <span className="text-[10px] font-medium uppercase text-muted-foreground">
                      Step {index + 1}
                    </span>
                    <span className="truncate text-xs font-semibold text-foreground">
                      {label}
                      {isComplete && publishWizardStepSummaries[index]
                        ? `: ${publishWizardStepSummaries[index]}`
                        : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </DialogHeader>

          <DialogPanel className="space-y-5 border-b border-border/70 bg-muted/20 px-6 py-5">
            <AnimatedHeight>
              <div className={cn("space-y-2", publishWizardStep !== 0 && "hidden")}>
                <span
                  id="publish-provider-cards-label"
                  className="text-xs font-medium text-foreground"
                >
                  Provider
                </span>
                <RadioGroup
                  value={publishProvider}
                  onValueChange={(value) => setPublishProvider(value as PublishProviderKind)}
                  aria-labelledby="publish-provider-cards-label"
                  className="grid grid-cols-2 gap-2.5"
                >
                  {sortedPublishProviderOptions.map((option) => {
                    const readiness = publishProviderReadiness[option.value];
                    const isSelected = publishProvider === option.value && readiness.ready;
                    if (!readiness.ready) {
                      return (
                        <div
                          key={option.value}
                          className="relative flex cursor-not-allowed items-center gap-3 rounded-lg border border-border bg-background px-3 py-3 text-left opacity-55"
                        >
                          <option.Icon
                            className="size-5 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                            {option.label}
                          </span>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="outline"
                                  size="xs"
                                  className="h-5 rounded-[.25rem] px-1.5 text-[10px] text-warning-foreground"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    openSourceControlSettings();
                                  }}
                                >
                                  Setup Required
                                </Button>
                              }
                            />
                            <TooltipPopup side="top" align="end" className="max-w-72">
                              {readiness.hint ??
                                "Open Settings -> Source Control to configure this provider."}
                            </TooltipPopup>
                          </Tooltip>
                        </div>
                      );
                    }

                    return (
                      <RadioPrimitive.Root
                        key={option.value}
                        value={option.value}
                        className={cn(
                          "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-left outline-none transition-[background-color,border-color,box-shadow]",
                          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                          isSelected
                            ? "border-primary bg-background shadow-sm ring-2 ring-primary/35"
                            : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50",
                        )}
                      >
                        <option.Icon className="size-5 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {option.label}
                        </span>
                      </RadioPrimitive.Root>
                    );
                  })}
                </RadioGroup>
              </div>

              <div className={cn("space-y-5", publishWizardStep !== 1 && "hidden")}>
                <div className="space-y-2">
                  <label
                    htmlFor="publish-repository-path"
                    className="text-xs font-medium text-foreground"
                  >
                    Repository
                  </label>
                  <div className="flex items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ring">
                    <span className="flex shrink-0 items-center gap-1.5 border-r border-input bg-muted/50 px-2.5 font-mono text-xs text-muted-foreground">
                      <currentPublishProvider.Icon className="size-3.5" />
                      {publishHost}/
                    </span>
                    <input
                      id="publish-repository-path"
                      name="publish-repository-path"
                      value={publishRepository}
                      onChange={(event) => {
                        setPublishRepository(event.target.value);
                        setHasUserEditedPublishRepository(true);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          submitPublishRepository();
                        }
                      }}
                      placeholder={publishPathPlaceholder}
                      disabled={publishRepositoryMutation.isPending}
                      className="w-full bg-transparent px-3 py-2 font-mono text-sm placeholder:text-muted-foreground/60 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <span
                    id="publish-visibility-cards-label"
                    className="text-xs font-medium text-foreground"
                  >
                    Visibility
                  </span>
                  <RadioGroup
                    value={publishVisibility}
                    onValueChange={(value) =>
                      setPublishVisibility(value as SourceControlRepositoryVisibility)
                    }
                    aria-labelledby="publish-visibility-cards-label"
                    disabled={publishRepositoryMutation.isPending}
                    className="grid grid-cols-2 gap-2.5"
                  >
                    {[
                      {
                        value: "private" as const,
                        label: "Private",
                        description: "Only invited people",
                        Icon: LockIcon,
                      },
                      {
                        value: "public" as const,
                        label: "Public",
                        description: "Anyone on the web",
                        Icon: GlobeIcon,
                      },
                    ].map((option) => {
                      const isSelected = publishVisibility === option.value;
                      return (
                        <RadioPrimitive.Root
                          key={option.value}
                          value={option.value}
                          className={cn(
                            "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]",
                            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                            isSelected
                              ? "border-primary bg-background shadow-sm ring-2 ring-primary/35"
                              : "border-border bg-background hover:border-foreground/20 hover:text-foreground",
                          )}
                        >
                          <option.Icon
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-foreground">
                              {option.label}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {option.description}
                            </span>
                          </span>
                        </RadioPrimitive.Root>
                      );
                    })}
                  </RadioGroup>
                </div>

                <div>
                  <button
                    type="button"
                    onClick={() => setPublishAdvancedOpen((prev) => !prev)}
                    aria-expanded={publishAdvancedOpen}
                    className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronDownIcon
                      className={cn(
                        "size-3.5 transition-transform",
                        publishAdvancedOpen ? "" : "-rotate-90",
                      )}
                    />
                    Advanced
                  </button>
                  {publishAdvancedOpen ? (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <label className="space-y-1.5" htmlFor="publish-remote-name">
                        <span className="text-xs font-medium text-foreground">Remote</span>
                        <Input
                          id="publish-remote-name"
                          value={publishRemoteName}
                          onChange={(event) => setPublishRemoteName(event.target.value)}
                          placeholder="origin"
                          disabled={publishRepositoryMutation.isPending}
                        />
                      </label>
                      <div className="space-y-1.5">
                        <span
                          id="publish-protocol-label"
                          className="text-xs font-medium text-foreground"
                        >
                          Protocol
                        </span>
                        <RadioGroup
                          value={publishProtocol}
                          onValueChange={(value) =>
                            setPublishProtocol(value as SourceControlCloneProtocol)
                          }
                          aria-labelledby="publish-protocol-label"
                          disabled={publishRepositoryMutation.isPending}
                          className="grid grid-cols-2 gap-2"
                        >
                          {(["ssh", "https"] as const).map((value) => {
                            const isSelected = publishProtocol === value;
                            return (
                              <RadioPrimitive.Root
                                key={value}
                                value={value}
                                className={cn(
                                  "rounded-md border px-3 py-1.5 text-center text-sm font-medium outline-none transition",
                                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                                  isSelected
                                    ? "border-primary bg-background ring-2 ring-primary/35 text-foreground"
                                    : "border-border bg-background text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                                )}
                              >
                                {value === "ssh" ? "SSH" : "HTTPS"}
                              </RadioPrimitive.Root>
                            );
                          })}
                        </RadioGroup>
                      </div>
                    </div>
                  ) : null}
                </div>

                {publishRepositoryMutation.isPending ? (
                  <div
                    role="status"
                    aria-live="polite"
                    className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                  >
                    <Spinner className="size-3.5" aria-hidden />
                    Publishing repository to {publishProviderLabel}...
                  </div>
                ) : null}
                {publishError && !publishRepositoryMutation.isPending ? (
                  <div
                    role="alert"
                    className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                  >
                    <p className="font-medium">Publish failed</p>
                    <p className="mt-0.5 text-destructive/90">{publishError}</p>
                  </div>
                ) : null}
              </div>

              <div className={cn("space-y-4", publishWizardStep !== 2 && "hidden")}>
                {publishResult ? (
                  <>
                    <div className="flex flex-col items-center gap-2 py-1 text-center">
                      <span className="grid size-8 place-items-center rounded-full bg-success/15 text-success">
                        <CheckIcon className="size-4" aria-hidden />
                      </span>
                      <h3 className="text-sm font-semibold text-foreground">
                        {publishResult.status === "pushed"
                          ? "Repository published"
                          : "Repository created"}
                      </h3>
                      <p className="max-w-xs text-pretty text-xs text-muted-foreground">
                        {publishResult.status === "pushed"
                          ? `${publishResult.branch} is now live on ${publishProviderLabel}.`
                          : `Remote "${publishResult.remoteName}" is set up. Make a commit and push it to share your code.`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 rounded-lg border border-input bg-muted/40 px-3 py-2">
                      <currentPublishProvider.Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                        {publishResult.repository.nameWithOwner}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => {
                        const api = readLocalApi();
                        if (!api) return;
                        void api.shell.openExternal(publishResult.repository.url);
                      }}
                    >
                      <ExternalLinkIcon className="size-3.5" aria-hidden />
                      Open on {publishProviderLabel}
                    </Button>
                  </>
                ) : (
                  <div className="rounded-md border border-input bg-background px-3 py-2 text-xs text-muted-foreground">
                    Publish result unavailable.
                  </div>
                )}
              </div>
            </AnimatedHeight>
          </DialogPanel>

          <DialogFooter>
            {publishWizardStep === 2 ? (
              <Button size="sm" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={publishRepositoryMutation.isPending}
                  onClick={() => {
                    if (publishWizardStep === 0) {
                      handleOpenChange(false);
                      return;
                    }
                    setPublishWizardStep((step) => Math.max(0, step - 1));
                  }}
                >
                  {publishWizardStep === 0 ? "Cancel" : "Back"}
                </Button>
                {publishWizardStep < 1 ? (
                  <Button
                    size="sm"
                    disabled={!hasReadyPublishProvider || !selectedPublishProviderReadiness.ready}
                    onClick={() => setPublishWizardStep((step) => Math.min(1, step + 1))}
                  >
                    Next
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={!canSubmitPublishRepository}
                    onClick={submitPublishRepository}
                  >
                    {publishRepositoryMutation.isPending ? (
                      <>
                        <Spinner className="size-3.5" aria-hidden />
                        Publishing...
                      </>
                    ) : (
                      "Publish"
                    )}
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
