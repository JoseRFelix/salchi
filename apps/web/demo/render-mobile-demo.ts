import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright";

const VIDEO_WIDTH = 720;
const VIDEO_HEIGHT = 1560;
const VIEWPORT_WIDTH = 390;
const VIEWPORT_HEIGHT = 844;
const CAPTURE_FRAME_RATE = 60;
const OUTPUT_FRAME_RATE = 60;
const CAPTURE_FRAME_INTERVAL_MS = 1_000 / CAPTURE_FRAME_RATE;
const COMPLETED_TURN_SUMMARY_SELECTOR = '[data-timeline-row-kind="turn-fold"]';
const SUBAGENT_SPAWN_SELECTOR = '[data-timeline-anchor-id$=":parent-spawn"]';
const SUBAGENT_RESULT_SELECTOR = '[data-timeline-anchor-id$=":parent-child-result"]';
const SUBAGENT_DEMO_PROMPT =
  "Create three subagents that output three popular physics constants and then report to parent an interesting fact about these three constants";

const { values: options } = parseArgs({
  options: {
    "base-url": {
      default: process.env.SALCHI_DEMO_BASE_URL ?? "http://127.0.0.1:3773",
      type: "string",
    },
    "pairing-token": {
      default: process.env.SALCHI_DEMO_PAIRING_TOKEN,
      type: "string",
    },
    "storage-state": {
      default: process.env.SALCHI_DEMO_STORAGE_STATE,
      type: "string",
    },
    "subagent-thread": {
      default: process.env.SALCHI_DEMO_SUBAGENT_THREAD ?? "Subagents Report Physics Constants",
      type: "string",
    },
  },
  strict: true,
});

const outputPath = resolve(process.env.SALCHI_DEMO_OUTPUT ?? "assets/salchi/salchi-demo.mp4");
const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "salchi-mobile-demo-"));
const storageStatePath = options["storage-state"] ? resolve(options["storage-state"]) : undefined;

if (!storageStatePath && !options["pairing-token"]) {
  throw new Error(
    "Provide --storage-state or --pairing-token so the recorder can open the actual Salchi app.",
  );
}
if (storageStatePath && !existsSync(storageStatePath)) {
  throw new Error(`Storage state does not exist: ${storageStatePath}`);
}

await mkdir(dirname(outputPath), { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage", "--disable-gpu"],
});
const context = await browser.newContext({
  colorScheme: "dark",
  deviceScaleFactor: 2,
  serviceWorkers: "block",
  ...(storageStatePath ? { storageState: storageStatePath } : {}),
  viewport: {
    height: VIEWPORT_HEIGHT,
    width: VIEWPORT_WIDTH,
  },
});
await context.addInitScript(() => {
  try {
    localStorage.setItem("salchi:claude-login-notification-shown:v1", "true");
  } catch {
    // about:blank has no storage origin; the script runs again after app navigation.
  }
});

let capturing = false;
let captureEnabled = false;
let capturePromise: Promise<number> | null = null;
let capturePausedAt: number | null = null;
let capturePausedDurationMs = 0;

function pauseCapture(): void {
  if (!captureEnabled) {
    return;
  }
  captureEnabled = false;
  capturePausedAt = performance.now();
}

function resumeCapture(): void {
  if (captureEnabled) {
    return;
  }
  if (capturePausedAt !== null) {
    capturePausedDurationMs += performance.now() - capturePausedAt;
    capturePausedAt = null;
  }
  captureEnabled = true;
}

try {
  const page = await context.newPage();
  page.on("crash", () => console.error("The recording page crashed."));
  const baseUrl = options["base-url"].replace(/\/$/, "");

  if (options["pairing-token"]) {
    await page.goto(`${baseUrl}/pair#token=${encodeURIComponent(options["pairing-token"])}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForURL((url) => url.pathname !== "/pair", { timeout: 15_000 });
  } else {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  }

  await openThreadFromSearch(page, options["subagent-thread"]);
  await page.waitForTimeout(600);
  const subagentSpawnCount = await prepareSubagentReplay(page);
  await preparePromptReplay(page, SUBAGENT_DEMO_PROMPT);
  await prepareDemoModelLabel(page, "5.6 Sol");

  capturing = true;
  captureEnabled = true;
  const captureStartedAt = performance.now();
  capturePromise = captureCompositorFrames(
    page,
    temporaryDirectory,
    () => capturing,
    () => captureEnabled,
  );

  // Replay the real prompt entering the timeline before any child work appears.
  console.log("Recording prompt send");
  await delay(900);
  await replayPromptSend(page);
  await delay(550);

  // Replay the real child-thread events so the three subagents visibly spawn in sequence.
  console.log("Recording subagent flow");
  for (let index = 0; index < subagentSpawnCount; index += 1) {
    await revealSubagentSpawn(page, index);
    await delay(800);
  }
  await revealSubagentResults(page);
  await delay(1_600);

  // The native mobile sidebar shows a working thread and projects from multiple repos.
  console.log("Recording project sidebar");
  await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  await prepareSidebarShowcase(page);
  await delay(450);
  await revealSidebarSubagents(page);
  await delay(2_200);

  // Jump directly from the sidebar to the ready file explorer.
  console.log("Preparing file explorer");
  pauseCapture();
  await page
    .getByLabel("Sidebar", { exact: true })
    .getByRole("button", { name: "Toggle Sidebar", exact: true })
    .click();
  await page.getByRole("button", { name: "More thread actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "File explorer", exact: true }).click();
  await page.getByRole("button", { name: "Refresh file explorer", exact: true }).waitFor();
  resumeCapture();
  console.log("Recording file explorer");
  await delay(600);
  await page.locator('button[title="apps"]').click();
  await delay(300);
  await slowlyRevealExplorerEntry(page, 'button[title="apps/web"]', 900);
  await page.locator('button[title="apps/web"]').click();
  await delay(300);
  await slowlyRevealExplorerEntry(page, 'button[title="apps/web/demo"]', 900);
  await page.locator('button[title="apps/web/demo"]').click();
  await delay(300);
  await slowlyRevealExplorerEntry(page, 'button[title="apps/web/demo/render-mobile-demo.ts"]', 650);

  // Open a real file from the expanded explorer tree in Salchi's native preview.
  console.log("Recording file preview");
  await page.locator('button[title="apps/web/demo/render-mobile-demo.ts"]').click();
  const closeFilePreview = page.getByRole("button", { name: "Close file preview", exact: true });
  await closeFilePreview.waitFor();
  await page.getByText("Loading file preview...", { exact: true }).waitFor({ state: "hidden" });
  await page.locator(".workspace-file-preview-virtualizer").waitFor();
  await delay(650);
  await smoothlyScrollBy(page, ".workspace-file-preview-virtualizer", 760, 2_100);
  await delay(550);

  // Close the file on camera, return to the thread, then open source control from the toolbar.
  console.log("Recording source control transition");
  await closeFilePreview.click({ delay: 120 });
  await page.getByRole("button", { name: "More thread actions", exact: true }).waitFor();
  await delay(550);
  await page
    .getByRole("button", { name: "Toggle source control", exact: true })
    .click({ delay: 120 });
  await page.getByRole("button", { name: "Close source control panel", exact: true }).waitFor();
  const sourceControlDemoFile = page.locator(
    '[data-source-control-row-key][data-source-control-path="apps/web/demo/render-mobile-demo.ts"]',
  );
  await sourceControlDemoFile.waitFor();
  console.log("Recording source control");
  await delay(1_000);

  // Select a visible changed file on camera so its transition into the diff is explicit.
  console.log("Recording diff selection");
  await sourceControlDemoFile.getByRole("button").first().click({ delay: 180 });
  const closeDiffPreview = page.getByRole("button", {
    name: /^Close (?:file preview|diff|inline diff)$/,
  });
  await closeDiffPreview.waitFor();
  const selectedDiffFile = page.locator(
    '[data-diff-file-path="apps/web/demo/render-mobile-demo.ts"]',
  );
  await selectedDiffFile.waitFor();
  await selectedDiffFile.evaluate((element) => {
    element.scrollIntoView({ block: "start" });
  });
  console.log("Recording diff");
  await delay(550);
  await smoothlyScrollBy(page, ".diff-render-surface", 900, 2_300);
  await delay(550);

  // Cut directly from the diff to a ready terminal, then type the command on camera.
  console.log("Preparing terminal");
  pauseCapture();
  await closeDiffPreview.click();
  await page.getByRole("button", { name: "Toggle terminal drawer", exact: true }).click();
  await page.locator(".xterm-helper-textarea").last().waitFor();
  await page.locator(".xterm-helper-textarea").last().focus();
  await page.keyboard.type("function fish_prompt; printf 'salchi (main) > '; end");
  await page.keyboard.press("Enter");
  await delay(250);
  await page.keyboard.press("Control+L");
  await delay(150);
  resumeCapture();
  console.log("Recording terminal");
  await delay(200);
  await page.keyboard.type("git status --short", { delay: 20 });
  await page.keyboard.press("Enter");
  await delay(1_800);

  const captureFinishedAt = performance.now();
  const unfinishedPauseDurationMs =
    capturePausedAt === null ? 0 : captureFinishedAt - capturePausedAt;
  const captureDurationSeconds =
    (captureFinishedAt - captureStartedAt - capturePausedDurationMs - unfinishedPauseDurationMs) /
    1_000;
  capturing = false;
  const capturedFrameCount = await capturePromise;
  const capturedFrameRate = capturedFrameCount / captureDurationSeconds;
  capturePromise = null;
  await context.close();

  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-framerate",
      capturedFrameRate.toFixed(6),
      "-i",
      resolve(temporaryDirectory, "frame-%06d.jpg"),
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-t",
      captureDurationSeconds.toFixed(3),
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-vf",
      `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:flags=lanczos,unsharp=5:5:0.2,format=yuv420p`,
      "-r",
      String(OUTPUT_FRAME_RATE),
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "16",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-movflags",
      "+faststart",
      "-shortest",
      outputPath,
    ],
    { stdio: "inherit" },
  );
} finally {
  capturing = false;
  if (capturePromise) {
    await capturePromise.catch(() => undefined);
  }
  await browser.close();
  await rm(temporaryDirectory, { force: true, recursive: true });
}

console.log(`Rendered ${outputPath}`);

async function prepareSubagentReplay(page: Page): Promise<number> {
  const spawnRows = page.locator(SUBAGENT_SPAWN_SELECTOR);
  const spawnCount = await spawnRows.count();
  if (spawnCount < 3) {
    throw new Error(`Expected at least three subagent spawn events, found ${spawnCount}.`);
  }

  await page.evaluate(
    ({ completedTurnSummarySelector, resultSelector, spawnSelector }) => {
      const hide = (element: Element, translate = false) => {
        if (!(element instanceof HTMLElement)) {
          return;
        }
        element.style.display = "none";
        element.style.visibility = "hidden";
        element.style.opacity = "0";
        element.style.transform = translate ? "translateY(-8px)" : "none";
        element.style.transition = "opacity 280ms ease, transform 280ms ease";
      };

      document
        .querySelectorAll(spawnSelector)
        .forEach((element) => hide(element.closest("section") ?? element, true));
      document
        .querySelectorAll(resultSelector)
        .forEach((element) => hide(element.closest("section") ?? element));
      document.querySelectorAll(completedTurnSummarySelector).forEach((element) => hide(element));
      document
        .querySelectorAll('[data-timeline-row-kind="work"] button')
        .forEach((element) => hide(element));
      document
        .querySelectorAll('[data-message-role="assistant"]')
        .forEach((element) => hide(element));
      document.querySelectorAll('[data-message-role="user"]').forEach((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          node.textContent =
            node.textContent?.replace("a interesting fact", "an interesting fact") ?? "";
        }
        hide(element);
      });
    },
    {
      completedTurnSummarySelector: COMPLETED_TURN_SUMMARY_SELECTOR,
      resultSelector: SUBAGENT_RESULT_SELECTOR,
      spawnSelector: SUBAGENT_SPAWN_SELECTOR,
    },
  );

  return Math.min(spawnCount, 3);
}

async function preparePromptReplay(page: Page, prompt: string): Promise<void> {
  await page.getByRole("button", { name: "Expand composer", exact: true }).click();
  const editor = page.locator('[data-chat-composer-form="true"] [contenteditable="true"]').last();
  await editor.waitFor();
  await editor.fill(prompt);
}

async function prepareDemoModelLabel(page: Page, label: string): Promise<void> {
  await page.locator('[data-chat-provider-model-picker="true"]').last().waitFor();
  await page.evaluate((modelLabel) => {
    const updateModelLabels = () => {
      document
        .querySelectorAll<HTMLElement>('[data-chat-provider-model-picker="true"]')
        .forEach((picker) => {
          const visibleLabel = picker.querySelector<HTMLElement>("span.min-w-0.truncate");
          if (visibleLabel && visibleLabel.textContent !== modelLabel) {
            visibleLabel.textContent = modelLabel;
          }
          picker.setAttribute("aria-label", modelLabel);
          picker.setAttribute("title", modelLabel);
        });
    };

    updateModelLabels();
    const observer = new MutationObserver(updateModelLabels);
    observer.observe(document.body, { childList: true, subtree: true });
  }, label);
}

async function replayPromptSend(page: Page): Promise<void> {
  const sendButton = page.getByRole("button", { name: "Send message", exact: true });
  await sendButton.evaluate(async (element) => {
    const animation = element.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(0.82)", offset: 0.45 },
        { transform: "scale(1)" },
      ],
      { duration: 220, easing: "ease-out" },
    );
    await animation.finished;
  });

  const editor = page.locator('[data-chat-composer-form="true"] [contenteditable="true"]').last();
  await editor.fill("");
  await page.waitForTimeout(80);
  await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).focus();

  const userMessage = page.locator('[data-message-role="user"]').last();
  await page.waitForTimeout(160);
  await userMessage.evaluate((element) => {
    if (element instanceof HTMLElement) {
      element.style.display = "";
      element.style.visibility = "visible";
      element.style.opacity = "0";
    }
  });
  const timeline = page.getByTestId("messages-timeline-list");
  await timeline.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForTimeout(50);
  await timeline.evaluate((element) => {
    element.scrollTop = 0;
  });
  await userMessage.evaluate(async (element) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const animation = element.animate(
      [
        { opacity: 0, transform: "translateY(22px) scale(0.98)" },
        { opacity: 1, transform: "translateY(0) scale(1)" },
      ],
      {
        duration: 420,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "forwards",
      },
    );
    await animation.finished;
    element.style.opacity = "1";
    element.style.transform = "none";
  });
}

async function revealSubagentSpawn(page: Page, index: number): Promise<void> {
  await page
    .locator(SUBAGENT_SPAWN_SELECTOR)
    .nth(index)
    .evaluate((element) => {
      const replayElement = element.closest("section") ?? element;
      if (!(replayElement instanceof HTMLElement)) {
        return;
      }
      replayElement.style.display = "";
      replayElement.style.visibility = "visible";
      window.requestAnimationFrame(() => {
        replayElement.style.opacity = "1";
        replayElement.style.transform = "translateY(0)";
      });
    });
}

async function revealSubagentResults(page: Page): Promise<void> {
  await page.evaluate(
    ({ completedTurnSummarySelector, resultSelector }) => {
      const reveal = (element: Element) => {
        if (!(element instanceof HTMLElement)) {
          return;
        }
        element.style.display = "";
        element.style.visibility = "visible";
        window.requestAnimationFrame(() => {
          element.style.opacity = "1";
        });
      };

      document
        .querySelectorAll(resultSelector)
        .forEach((element) => reveal(element.closest("section") ?? element));
      document.querySelectorAll(completedTurnSummarySelector).forEach(reveal);
      document.querySelectorAll('[data-timeline-row-kind="work"] button').forEach(reveal);
      document.querySelectorAll('[data-message-role="assistant"]').forEach(reveal);
    },
    {
      completedTurnSummarySelector: COMPLETED_TURN_SUMMARY_SELECTOR,
      resultSelector: SUBAGENT_RESULT_SELECTOR,
    },
  );
}

async function prepareSidebarShowcase(page: Page): Promise<void> {
  await page.locator("[data-thread-item]").nth(5).waitFor({ state: "attached" });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-thread-item]")).slice(
      0,
      6,
    );
    if (rows.length < 6) {
      throw new Error("Expected six reusable Salchi sidebar rows.");
    }

    const chevronTemplate = document.querySelector<SVGElement>("svg.lucide-chevron-right");
    const branchTemplate = document.querySelector<SVGElement>("svg.lucide-git-branch");
    if (!chevronTemplate || !branchTemplate) {
      throw new Error("Expected native chevron and branch elements in the Salchi UI.");
    }

    const rowButton = (row: HTMLElement) =>
      row.querySelector<HTMLElement>('[data-testid^="thread-row-"]');
    const rowLeadingContent = (row: HTMLElement) => rowButton(row)?.firstElementChild;

    const makeTitle = (title: string) => {
      const titleElement = document.createElement("span");
      titleElement.className = "min-w-0 flex-1 truncate";
      titleElement.dataset.demoSidebarTitle = title;
      titleElement.textContent = title;
      return titleElement;
    };

    const makeStatus = (label: "Completed" | "Working") => {
      const isWorking = label === "Working";
      const color = isWorking ? "sky" : "emerald";
      const status = document.createElement("span");
      status.setAttribute("aria-label", label);
      status.className = `inline-flex items-center gap-1 text-[10px] text-${color}-600 dark:text-${color}-300/${
        isWorking ? "80" : "90"
      }`;

      const dot = document.createElement("span");
      dot.className = `h-1.5 w-1.5 rounded-full bg-${color}-500 dark:bg-${color}-300/${
        isWorking ? "80 animate-pulse" : "90"
      }`;
      const text = document.createElement("span");
      text.className = "hidden md:inline";
      text.textContent = label;
      status.append(dot, text);
      return status;
    };

    const setRowTime = (row: HTMLElement) => {
      const button = rowButton(row);
      const time = button?.querySelector<HTMLElement>("span.text-\\[10px\\].tabular-nums");
      if (time) {
        time.textContent = "just now";
      }
      button?.querySelectorAll<HTMLElement>("button").forEach((element) => {
        if (!element.dataset.demoSidebarExpand) {
          element.style.display = "none";
        }
      });
    };

    const workingTitles = ["Create Salchi Mobile PWA Demo", "Add Claude Opus 5 Model"];
    rows.slice(0, 2).forEach((row, index) => {
      const leadingContent = rowLeadingContent(row);
      if (!(leadingContent instanceof HTMLElement)) {
        return;
      }
      leadingContent.className = "flex min-w-0 flex-1 items-center gap-1.5 text-left";
      leadingContent.replaceChildren(
        makeStatus("Working"),
        makeTitle(workingTitles[index] ?? "Working thread"),
      );
      setRowTime(row);
    });

    const parentRow = rows[2];
    const parentLeadingContent = parentRow ? rowLeadingContent(parentRow) : null;
    if (!(parentLeadingContent instanceof HTMLElement)) {
      throw new Error("Expected a native sidebar row for the completed parent thread.");
    }
    parentLeadingContent.className = "flex min-w-0 flex-1 items-center gap-1.5 text-left";

    const expandButton = document.createElement("button");
    expandButton.type = "button";
    expandButton.dataset.demoSidebarExpand = "true";
    expandButton.setAttribute("aria-label", "Collapse Physics constants report");
    expandButton.setAttribute("aria-expanded", "true");
    expandButton.className =
      "-ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70";
    const chevron = chevronTemplate.cloneNode(true) as SVGElement;
    chevron.className.baseVal = "size-3.5 rotate-90";
    expandButton.append(chevron);

    parentLeadingContent.replaceChildren(
      expandButton,
      makeStatus("Completed"),
      makeTitle("Physics constants report"),
    );
    parentRow.dataset.demoSidebarParent = "true";
    setRowTime(parentRow);

    const childTitles = ["Speed of light", "Planck constant", "Gravitational constant"];
    rows.slice(3, 6).forEach((row, index) => {
      const leadingContent = rowLeadingContent(row);
      if (!(leadingContent instanceof HTMLElement)) {
        return;
      }
      leadingContent.className = "flex min-w-0 flex-1 items-center gap-1.5 pl-3 text-left";

      const branchWrapper = document.createElement("span");
      branchWrapper.className =
        "inline-flex size-3 shrink-0 items-center justify-center text-muted-foreground/55";
      const branch = branchTemplate.cloneNode(true) as SVGElement;
      branch.className.baseVal = "size-3";
      branchWrapper.append(branch);

      leadingContent.replaceChildren(branchWrapper, makeTitle(childTitles[index] ?? "Subagent"));
      row.dataset.demoSidebarSubagent = String(index);
      row.style.opacity = "0";
      row.style.transform = "translateX(-8px)";
      row.style.transition = "opacity 220ms ease, transform 260ms ease";
      setRowTime(row);
    });
  });
}

async function revealSidebarSubagents(page: Page): Promise<void> {
  const subagentRows = page.locator("[data-demo-sidebar-subagent]");
  for (let index = 0; index < (await subagentRows.count()); index += 1) {
    await subagentRows.nth(index).evaluate((element) => {
      if (element instanceof HTMLElement) {
        element.style.opacity = "1";
        element.style.transform = "translateX(0)";
      }
    });
    await delay(180);
  }
}

async function openThreadFromSearch(page: Page, threadTitle: string): Promise<void> {
  await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  await page.getByText("Search", { exact: true }).click();
  await page
    .locator('input[placeholder="Search commands, projects, and threads..."]')
    .fill(threadTitle);
  await page.getByRole("dialog").getByText(threadTitle, { exact: true }).first().click();
  await page.getByRole("button", { name: "More thread actions", exact: true }).waitFor();
}

async function slowlyRevealExplorerEntry(
  page: Page,
  targetSelector: string,
  durationMs: number,
): Promise<void> {
  await page.locator(targetSelector).waitFor({ state: "attached" });
  await page.evaluate(
    async ({ duration, selector }) => {
      const scroller = document.querySelector<HTMLElement>(
        '[data-testid="workspace-file-explorer-scroll"]',
      );
      const target = document.querySelector<HTMLElement>(selector);
      if (!scroller || !target) {
        throw new Error(`Could not reveal explorer entry: ${selector}`);
      }

      const scrollerRect = scroller.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const desiredTop = scrollerRect.top + scrollerRect.height * 0.58;
      const start = scroller.scrollTop;
      const destination = Math.max(
        0,
        Math.min(
          scroller.scrollHeight - scroller.clientHeight,
          start + targetRect.top - desiredTop,
        ),
      );
      await animateScroll(scroller, start, destination, duration);

      function animateScroll(
        element: HTMLElement,
        from: number,
        to: number,
        animationDuration: number,
      ): Promise<void> {
        if (Math.abs(to - from) < 1) {
          return Promise.resolve();
        }
        return new Promise((resolveAnimation) => {
          const startedAt = performance.now();
          const tick = (now: number) => {
            const progress = Math.min(1, (now - startedAt) / animationDuration);
            const eased = 0.5 - Math.cos(Math.PI * progress) / 2;
            element.scrollTop = from + (to - from) * eased;
            if (progress < 1) {
              window.requestAnimationFrame(tick);
            } else {
              resolveAnimation();
            }
          };
          window.requestAnimationFrame(tick);
        });
      }
    },
    { duration: durationMs, selector: targetSelector },
  );
}

async function smoothlyScrollBy(
  page: Page,
  scrollSelector: string,
  distance: number,
  durationMs: number,
): Promise<void> {
  await page
    .locator(scrollSelector)
    .last()
    .evaluate(
      async (element, { animationDuration, scrollDistance }) => {
        if (!(element instanceof HTMLElement)) {
          throw new Error("Expected a scrollable HTML element.");
        }
        const start = element.scrollTop;
        const destination = Math.max(
          0,
          Math.min(element.scrollHeight - element.clientHeight, start + scrollDistance),
        );
        if (Math.abs(destination - start) < 1) {
          return;
        }

        await new Promise<void>((resolveAnimation) => {
          const startedAt = performance.now();
          const tick = (now: number) => {
            const progress = Math.min(1, (now - startedAt) / animationDuration);
            const eased = 0.5 - Math.cos(Math.PI * progress) / 2;
            element.scrollTop = start + (destination - start) * eased;
            if (progress < 1) {
              window.requestAnimationFrame(tick);
            } else {
              resolveAnimation();
            }
          };
          window.requestAnimationFrame(tick);
        });
      },
      { animationDuration: durationMs, scrollDistance: distance },
    );
}

async function captureCompositorFrames(
  page: Page,
  directory: string,
  shouldContinue: () => boolean,
  shouldCapture: () => boolean,
): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  let latestFrame: Buffer | null = null;
  let screencastError: Error | null = null;
  cdp.on("Page.screencastFrame", (event) => {
    latestFrame = Buffer.from(event.data, "base64");
    void cdp
      .send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch((error: unknown) => {
        screencastError = error instanceof Error ? error : new Error(String(error));
      });
  });
  await cdp.send("Page.startScreencast", {
    everyNthFrame: 1,
    format: "jpeg",
    maxHeight: VIEWPORT_HEIGHT * 2,
    maxWidth: VIEWPORT_WIDTH * 2,
    quality: 95,
  });

  let frame = 0;
  let nextFrameAt = performance.now();
  try {
    while (shouldContinue()) {
      if (screencastError) {
        throw screencastError;
      }
      if (!shouldCapture() || !latestFrame) {
        nextFrameAt = performance.now();
        await delay(4);
        continue;
      }

      const now = performance.now();
      if (now < nextFrameAt) {
        await delay(Math.max(1, nextFrameAt - now));
        continue;
      }

      await writeFile(
        resolve(directory, `frame-${String(frame).padStart(6, "0")}.jpg`),
        latestFrame,
      );
      frame += 1;
      nextFrameAt += CAPTURE_FRAME_INTERVAL_MS;

      // Avoid a burst of stale catch-up frames if the process was briefly descheduled.
      if (nextFrameAt < performance.now() - CAPTURE_FRAME_INTERVAL_MS) {
        nextFrameAt = performance.now();
      }
    }
  } finally {
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
  return frame;
}
