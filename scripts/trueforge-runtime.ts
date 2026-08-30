import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  formatRuntimeStatus,
  getRuntimeStatus,
  installTrueForgeRuntime,
  runtimeLayout,
  startTrueForgeRuntime,
  stopTrueForgeRuntime,
} from "../src/trueforge/runtime.js";

export function repositoryRoot(scriptUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(scriptUrl)), "..");
}

export async function runRuntimeCommand(
  command: string | undefined,
  repoRoot = repositoryRoot(),
): Promise<void> {
  const layout = runtimeLayout(repoRoot);
  switch (command) {
    case "install":
      await installTrueForgeRuntime(layout);
      return;
    case "start":
      await startTrueForgeRuntime(layout);
      return;
    case "status":
      process.stdout.write(`${formatRuntimeStatus(await getRuntimeStatus(layout), layout)}\n`);
      return;
    case "stop":
      await stopTrueForgeRuntime(layout);
      return;
    default:
      throw new Error(
        "Usage: pnpm trueforge:runtime:install | pnpm trueforge:runtime:start | pnpm trueforge:runtime:status | pnpm trueforge:runtime:stop",
      );
  }
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    await runRuntimeCommand(process.argv[2]);
  } catch (error) {
    process.stderr.write(
      `TrueForge runtime error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
