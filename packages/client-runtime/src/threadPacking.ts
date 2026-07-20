import type { TurnId } from "@salchi/contracts";

export interface ThreadPackingSessionEvidence {
  readonly status: string;
  readonly activeTurnId?: TurnId | null | undefined;
}

export interface ThreadPackingLatestTurnEvidence {
  readonly turnId: TurnId;
  readonly state: string;
  readonly completedAt: string | null;
}

export type ThreadPackingMessageRole = "user" | "assistant" | "system";

export function resolveEffectiveMessageTurnId(input: {
  readonly role: ThreadPackingMessageRole;
  readonly payloadTurnId: TurnId | null | undefined;
  readonly existingTurnId: TurnId | null | undefined;
  readonly session: ThreadPackingSessionEvidence | null | undefined;
  readonly latestTurn: ThreadPackingLatestTurnEvidence | null | undefined;
}): TurnId | null {
  if (input.payloadTurnId !== null && input.payloadTurnId !== undefined) {
    return input.payloadTurnId;
  }
  if (input.existingTurnId !== null && input.existingTurnId !== undefined) {
    return input.existingTurnId;
  }
  if (input.role !== "assistant") {
    return null;
  }

  const activeTurnId =
    input.session?.status === "running" ? (input.session.activeTurnId ?? null) : null;
  if (activeTurnId !== null) {
    return activeTurnId;
  }

  const latestTurn = input.latestTurn;
  if (latestTurn?.state === "running" && latestTurn.completedAt === null) {
    return latestTurn.turnId;
  }

  return null;
}

export function isTurnStillRunningForPacking(input: {
  readonly turnId: TurnId | null;
  readonly session: ThreadPackingSessionEvidence | null | undefined;
  readonly latestTurn: ThreadPackingLatestTurnEvidence | null | undefined;
}): boolean {
  if (input.turnId === null) {
    return false;
  }

  const sessionRunsThisTurn =
    input.session?.status === "running" &&
    (input.session.activeTurnId === input.turnId || input.session.activeTurnId == null);
  const latestTurnStillRunning =
    input.latestTurn?.turnId === input.turnId &&
    input.latestTurn.state === "running" &&
    input.latestTurn.completedAt === null;

  return sessionRunsThisTurn || latestTurnStillRunning;
}

export function settledTurnStateForSessionStatus(
  status: string,
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
    default:
      return null;
  }
}
