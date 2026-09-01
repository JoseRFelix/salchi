import type { SidebarProjectGroupingMode, SidebarProjectSortOrder } from "@salchi/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderPlusIcon,
  SearchIcon,
  Settings2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSeparator,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectFavicon } from "../ProjectFavicon";

export const ALL_PROJECTS_SCOPE = "__salchi_inbox_all_projects__";

const PROJECT_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Recent activity",
  created_at: "Recently created",
  manual: "Manual",
};

const PROJECT_GROUPING_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group repository checkouts",
  repository_path: "Group matching repository paths",
  separate: "Keep this checkout separate",
};

export function InboxProjectPicker(props: {
  readonly projects: readonly SidebarProjectSnapshot[];
  readonly selectedProject: SidebarProjectSnapshot | null;
  readonly selectedKey: string | null;
  readonly sortOrder: SidebarProjectSortOrder;
  readonly resolveGroupingMode: (project: SidebarProjectSnapshot) => SidebarProjectGroupingMode;
  readonly onSelect: (projectKey: string | null) => void;
  readonly onAddProject: () => void;
  readonly onSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  readonly onMoveProject: (project: SidebarProjectSnapshot, direction: -1 | 1) => void;
  readonly onGroupingModeChange: (
    project: SidebarProjectSnapshot,
    mode: SidebarProjectGroupingMode,
  ) => void;
  readonly onOpenGeneralSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const [settingsProject, setSettingsProject] = useState<SidebarProjectSnapshot | null>(null);
  const values = useMemo(
    () => [ALL_PROJECTS_SCOPE, ...props.projects.map((project) => project.projectKey)],
    [props.projects],
  );
  const filteredValues = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return values;
    return values.filter((value) => {
      if (value === ALL_PROJECTS_SCOPE) return "all projects".includes(normalized);
      const project = props.projects.find((candidate) => candidate.projectKey === value);
      return Boolean(
        project &&
        `${project.displayName} ${project.cwd} ${project.remoteEnvironmentLabels.join(" ")}`
          .toLocaleLowerCase()
          .includes(normalized),
      );
    });
  }, [props.projects, query, values]);
  const selectedIndex = props.selectedProject
    ? props.projects.findIndex(
        (project) => project.projectKey === props.selectedProject?.projectKey,
      )
    : -1;

  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <Combobox
          autoHighlight
          items={values}
          filteredItems={filteredValues}
          value={props.selectedKey ?? ALL_PROJECTS_SCOPE}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            props.onSelect(value === ALL_PROJECTS_SCOPE ? null : value);
          }}
          onOpenChange={(open) => {
            if (!open) setQuery("");
          }}
        >
          <ComboboxTrigger
            aria-label="Inbox project scope"
            className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm text-sidebar-foreground outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
          >
            {props.selectedProject ? (
              <ProjectFavicon
                environmentId={props.selectedProject.environmentId}
                cwd={props.selectedProject.cwd}
                className="size-4 shrink-0"
              />
            ) : (
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">
              {props.selectedProject?.displayName ?? "All projects"}
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
          </ComboboxTrigger>
          <ComboboxPopup className="w-[min(22rem,var(--available-width))]">
            <div className="border-b px-2 py-2">
              <ComboboxInput
                autoFocus
                inputClassName="h-7 bg-transparent text-sm"
                placeholder="Search projects…"
                showTrigger={false}
                size="sm"
                startAddon={<SearchIcon className="size-3.5" />}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <ComboboxEmpty>No projects match your search.</ComboboxEmpty>
            <ComboboxList className="max-h-64">
              <ComboboxItem hideIndicator value={ALL_PROJECTS_SCOPE}>
                <span className="flex min-w-0 items-center gap-2">
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">All projects</span>
                </span>
              </ComboboxItem>
              {props.projects.map((project) => (
                <ComboboxItem key={project.projectKey} hideIndicator value={project.projectKey}>
                  <span className="group/project-option flex min-w-0 items-center gap-2">
                    <ProjectFavicon
                      environmentId={project.environmentId}
                      cwd={project.cwd}
                      className="size-4 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{project.displayName}</span>
                      <span className="block truncate text-[10px] text-muted-foreground/60">
                        {project.cwd}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Settings for ${project.displayName}`}
                      className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/project-option:opacity-100 max-sm:opacity-100"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setSettingsProject(project);
                      }}
                    >
                      <Settings2Icon className="size-3.5" />
                    </button>
                  </span>
                </ComboboxItem>
              ))}
            </ComboboxList>
            <ComboboxSeparator />
            <div className="flex items-center gap-2 px-2 py-2">
              <span className="text-xs text-muted-foreground">Order</span>
              <Select
                value={props.sortOrder}
                onValueChange={(value) => {
                  if (value === "updated_at" || value === "created_at" || value === "manual") {
                    props.onSortOrderChange(value);
                  }
                }}
              >
                <SelectTrigger size="sm" className="ml-auto w-36" aria-label="Project order">
                  <SelectValue>{PROJECT_SORT_LABELS[props.sortOrder]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(
                    Object.entries(PROJECT_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>
                  ).map(([value, label]) => (
                    <SelectItem key={value} hideIndicator value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {props.sortOrder === "manual" && props.selectedProject ? (
                <span className="flex items-center">
                  <button
                    type="button"
                    aria-label={`Move ${props.selectedProject.displayName} up`}
                    disabled={selectedIndex <= 0}
                    className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                    onClick={() => props.onMoveProject(props.selectedProject!, -1)}
                  >
                    <ArrowUpIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${props.selectedProject.displayName} down`}
                    disabled={selectedIndex < 0 || selectedIndex >= props.projects.length - 1}
                    className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                    onClick={() => props.onMoveProject(props.selectedProject!, 1)}
                  >
                    <ArrowDownIcon className="size-3.5" />
                  </button>
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="flex h-9 w-full cursor-pointer items-center gap-2 border-t px-3 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={props.onAddProject}
            >
              <FolderPlusIcon className="size-4" />
              Add project
            </button>
          </ComboboxPopup>
        </Combobox>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Add project"
                className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                onClick={props.onAddProject}
              />
            }
          >
            <FolderPlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="right">Add project</TooltipPopup>
        </Tooltip>
      </div>

      <Dialog
        open={settingsProject !== null}
        onOpenChange={(open) => {
          if (!open) setSettingsProject(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{settingsProject?.displayName ?? "Project settings"}</DialogTitle>
            <DialogDescription className="break-all">{settingsProject?.cwd}</DialogDescription>
          </DialogHeader>
          {settingsProject ? (
            <div className="px-6 pb-6">
              <label className="flex flex-col gap-2 text-sm font-medium">
                Sidebar grouping
                <Select
                  value={props.resolveGroupingMode(settingsProject)}
                  onValueChange={(value) => {
                    if (
                      value === "repository" ||
                      value === "repository_path" ||
                      value === "separate"
                    ) {
                      props.onGroupingModeChange(settingsProject, value);
                    }
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Project grouping">
                    <SelectValue>
                      {PROJECT_GROUPING_LABELS[props.resolveGroupingMode(settingsProject)]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {(
                      Object.entries(PROJECT_GROUPING_LABELS) as Array<
                        [SidebarProjectGroupingMode, string]
                      >
                    ).map(([value, label]) => (
                      <SelectItem key={value} hideIndicator value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsProject(null)}>
              Done
            </Button>
            <Button onClick={props.onOpenGeneralSettings}>Open all settings</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
