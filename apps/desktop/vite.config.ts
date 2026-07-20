import { defineConfig } from "vite-plus";

const shouldLaunchElectronAfterPack = process.env.SALCHI_DESKTOP_DEV === "1";

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack",
        dependsOn: ["salchi#build"],
        cache: false,
      },
      dev: {
        command: "cross-env SALCHI_DESKTOP_DEV=1 vp pack --watch",
        dependsOn: ["salchi#build"],
        cache: false,
      },
      "dev:bundle": {
        command: "vp pack --watch",
        cache: false,
      },
      "dev:electron": {
        command: "node scripts/dev-electron.mjs",
        dependsOn: ["salchi#build"],
        cache: false,
      },
    },
  },
  pack: [
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/main.ts"],
      clean: true,
      deps: {
        alwaysBundle: (id) => id.startsWith("@salchi/"),
      },
      ...(shouldLaunchElectronAfterPack ? { onSuccess: "node scripts/dev-electron.mjs" } : {}),
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preload.ts"],
    },
  ],
});
