import {
  closestCorners,
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, type ReactNode } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { SidebarMenu } from "../ui/sidebar";

export type SidebarProjectDragCancelEvent = DragCancelEvent;
export type SidebarProjectDragEndEvent = DragEndEvent;
export type SidebarProjectDragStartEvent = DragStartEvent;
export type SidebarSortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function SortableProjectItem({
  projectId,
  children,
}: {
  projectId: string;
  children: (handleProps: SidebarSortableProjectHandleProps) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId });

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

export function SidebarProjectDndList({
  projects,
  onDragStart,
  onDragEnd,
  onDragCancel,
  renderProject,
}: {
  projects: readonly SidebarProjectSnapshot[];
  onDragStart: (event: SidebarProjectDragStartEvent) => void;
  onDragEnd: (event: SidebarProjectDragEndEvent) => void;
  onDragCancel: (event: SidebarProjectDragCancelEvent) => void;
  renderProject: (
    project: SidebarProjectSnapshot,
    handleProps: SidebarSortableProjectHandleProps,
  ) => ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    return pointerCollisions.length > 0 ? pointerCollisions : closestCorners(args);
  }, []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <SidebarMenu>
        <SortableContext
          items={projects.map((project) => project.projectKey)}
          strategy={verticalListSortingStrategy}
        >
          {projects.map((project) => (
            <SortableProjectItem key={project.projectKey} projectId={project.projectKey}>
              {(handleProps) => renderProject(project, handleProps)}
            </SortableProjectItem>
          ))}
        </SortableContext>
      </SidebarMenu>
    </DndContext>
  );
}
