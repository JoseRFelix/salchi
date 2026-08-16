// @effect-diagnostics nodeBuiltinImport:off - publish verification executes and reads a Node entrypoint.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class CliEntrypointVerificationError extends Error {
  override readonly name = "CliEntrypointVerificationError";
}

export function assertPortableCliEntrypoint(source: string, entrypointPath: string): void {
  if (source.includes("import.meta.main")) {
    throw new CliEntrypointVerificationError(
      `CLI entrypoint ${entrypointPath} uses import.meta.main, which silently skips execution ` +
        "on supported Node 22.16, 22.17, and 23.x releases.",
    );
  }
}

export async function verifyCliEntrypoint(
  entrypointPath: string,
  expectedVersion: string,
): Promise<void> {
  const source = await readFile(entrypointPath, "utf8");
  assertPortableCliEntrypoint(source, entrypointPath);

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [entrypointPath, "--version"], {
      encoding: "utf8",
      timeout: 30_000,
    }));
  } catch (cause) {
    throw new CliEntrypointVerificationError(
      `CLI entrypoint ${entrypointPath} failed its --version smoke test: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }

  const expectedOutput = `salchi v${expectedVersion}`;
  if (stdout.trim() !== expectedOutput) {
    throw new CliEntrypointVerificationError(
      `CLI entrypoint ${entrypointPath} printed ${JSON.stringify(stdout.trim())} for --version; ` +
        `expected ${JSON.stringify(expectedOutput)}.`,
    );
  }
}
