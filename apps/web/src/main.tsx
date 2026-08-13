import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { installIosStandaloneBackSwipeGuard } from "./iosStandaloneBackSwipeGuard";
import { getRouter } from "./router";
import { APP_BASE_NAME } from "./branding";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { installPwaAppBadgeSync } from "./pwa/appBadge";
import { registerPwaServiceWorker } from "./pwa/registerPwaServiceWorker";
import {
  getLastNotificationNavigationTarget,
  installServiceWorkerNotificationNavigation,
} from "./push/notificationNavigation";
import {
  buildStartupRestorePath,
  consumeStartupThreadRestoreTarget,
  primeStartupThreadRestore,
  readPersistedStartupThreadTarget,
} from "./startupNavigation";
import {
  hydrateOrchestrationIndexedDbStartupCache,
  hydrateOrchestrationStartupCache,
} from "./orchestrationStartupBootstrap";
import { installOrchestrationStartupCachePersistence } from "./orchestrationStartupCache";
import { useUiStateStore } from "./uiStateStore";
// Side-effect import: applies the selected color theme on boot to avoid a flash
// before React mounts. Self-initializes; the call below is explicit for clarity.
import { initColorTheme } from "./hooks/useColorTheme";

function bootstrapApplication(): void {
  // Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
  const startupThreadLastVisitedAtById = useUiStateStore.getState().threadLastVisitedAtById;
  installOrchestrationStartupCachePersistence();
  hydrateOrchestrationStartupCache();
  void hydrateOrchestrationIndexedDbStartupCache().catch(() => undefined);
  const history = isElectron ? createHashHistory() : createBrowserHistory();
  const persistedTarget = readPersistedStartupThreadTarget();
  primeStartupThreadRestore({
    pathname: history.location.pathname,
    persistedTarget,
    // Cache hydration seeds visit times for presentation state. Startup restoration must only use
    // visits that were actually persisted before this launch, or it can open an arbitrary cached
    // thread that the user never selected.
    threadLastVisitedAtById: startupThreadLastVisitedAtById,
  });
  const startupRestoreTarget = consumeStartupThreadRestoreTarget({
    lastNotificationNavigationTarget: getLastNotificationNavigationTarget(),
  });
  if (startupRestoreTarget !== null && history.location.pathname === "/") {
    history.replace(buildStartupRestorePath(startupRestoreTarget));
  }

  const router = getRouter(history);
  installServiceWorkerNotificationNavigation(router);

  if (isElectron) {
    syncDocumentWindowControlsOverlayClass();
  }

  initColorTheme();
  installIosStandaloneBackSwipeGuard();
  installPwaAppBadgeSync();
  registerPwaServiceWorker();

  document.title = APP_BASE_NAME;

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <RouterProvider router={router} />
    </React.StrictMode>,
  );
}

bootstrapApplication();
