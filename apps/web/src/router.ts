import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterHistory } from "@tanstack/react-router";

import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { routeTree } from "./routeTree.gen";

function EmptyPendingRouteComponent() {
  return null;
}

export const PRODUCTION_ROUTE_PENDING_OPTIONS = {
  // Keep the root application shell renderable while a lazy child route loads.
  // Without an explicit pending boundary, the child's suspension also withholds
  // the cached sidebar mounted by the root route.
  defaultPendingComponent: EmptyPendingRouteComponent,
  defaultPendingMs: 0,
  defaultPendingMinMs: 0,
} as const;

export function resolveRoutePendingOptions(isProduction: boolean) {
  return isProduction ? PRODUCTION_ROUTE_PENDING_OPTIONS : {};
}

export function getRouter(history: RouterHistory) {
  const queryClient = new QueryClient();

  return createRouter({
    routeTree,
    history,
    // Keep lazy route chunks out of the initial shell until navigation needs them.
    defaultPreload: false,
    context: {
      queryClient,
    },
    // Browser tests render deliberately unresolved matches without the load promise
    // that TanStack's production route loader supplies. Keep this production-only
    // so that test harness state cannot be mistaken for a rejected suspension.
    ...resolveRoutePendingOptions(import.meta.env.PROD),
    Wrap: ({ children }) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AppAtomRegistryProvider, undefined, children),
      ),
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
