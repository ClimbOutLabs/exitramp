import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import {
  SandboxVerificationReceiptSchema,
  VERIFICATION_COMMAND_PLAN,
  type SandboxVerificationReceipt,
} from "../eval/verification.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;

export interface CommandExecution {
  exitCode: number | null;
  timedOut: boolean;
  stdoutSha256: string;
  stderrSha256: string;
  durationMs: number;
}

export type VerificationCommandExecutor = (
  scriptName: string,
  cwd: string,
) => Promise<CommandExecution>;

export interface CollectVerificationReceiptsOptions {
  commitSha: string;
  sandboxId: string;
  cwd: string;
  execute?: VerificationCommandExecutor;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sandboxIdentifier(value = hostname()): string {
  const boundedHost = value.trim().slice(0, 160);
  if (boundedHost.length === 0) throw new Error("Sandbox hostname is empty.");
  return `trueforge-sandbox:${boundedHost}:${sha256(value).slice(7, 19)}`;
}

export async function executePnpmScript(
  scriptName: string,
  cwd: string,
): Promise<CommandExecution> {
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const startedAt = performance.now();

  return new Promise((resolveExecution) => {
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    const child = execFile(executable, [scriptName], {
      cwd,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      timeout: DEFAULT_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      stdoutHash.update(stdout);
      stderrHash.update(stderr);
      const timedOut = error !== null && error.killed === true && error.signal !== null;
      const exitCode = error === null
        ? 0
        : typeof error.code === "number"
          ? error.code
          : null;
      resolveExecution({
        exitCode,
        timedOut,
        stdoutSha256: `sha256:${stdoutHash.digest("hex")}`,
        stderrSha256: `sha256:${stderrHash.digest("hex")}`,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    });
  });
}

export async function collectVerificationReceipts(
  options: CollectVerificationReceiptsOptions,
): Promise<SandboxVerificationReceipt[]> {
  const execute = options.execute ?? executePnpmScript;
  const receipts: SandboxVerificationReceipt[] = [];

  for (const planned of VERIFICATION_COMMAND_PLAN) {
    const execution = await execute(planned.id, options.cwd);
    receipts.push(SandboxVerificationReceiptSchema.parse({
      sandbox_id: options.sandboxId,
      command_id: planned.id,
      command: planned.command,
      commit_sha: options.commitSha,
      exit_code: execution.exitCode,
      timed_out: execution.timedOut,
      stdout_sha256: execution.stdoutSha256,
      stderr_sha256: execution.stderrSha256,
      duration_ms: execution.durationMs,
    }));
  }

  return receipts;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  const commitSha = stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(commitSha)) {
    throw new Error("Sandbox checkout did not resolve to a 40-character Git commit.");
  }

  const verificationReceipts = await collectVerificationReceipts({
    commitSha,
    sandboxId: sandboxIdentifier(),
    cwd,
  });
  process.stdout.write(`${JSON.stringify({ verification_receipts: verificationReceipts })}\n`);
  if (verificationReceipts.some(({ exit_code, timed_out }) => exit_code !== 0 || timed_out)) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await main();
}
