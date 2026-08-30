import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const TRUEFORGE_REPOSITORY = "https://github.com/truefoundry/trueforge.git";
export const TRUEFORGE_TAG = "@truefoundry/trueforge@0.1.3";
export const TRUEFORGE_COMMIT = "141dd1fcd14dba620c2f1b5c12c4bf6d9dab2f97";
export const TRUEFORGE_URL = "http://127.0.0.1:8790";
export const EXITRAMP_URL = "http://127.0.0.1:8788";

const MANAGER_ID = "exitramp-trueforge-runtime-v1";
const PATCH_RELATIVE_PATH = join(
  "integrations",
  "trueforge",
  "trueforge-0.1.3-exitramp.patch",
);

export interface RuntimeLayout {
  repoRoot: string;
  managedRoot: string;
  runtimeDir: string;
  dataDir: string;
  sqlitePath: string;
  runDir: string;
  processFile: string;
  startLockFile: string;
  installManifestPath: string;
  runtimeMarkerPath: string;
  patchPath: string;
  evidenceDir: string;
}

export interface RuntimeProcessRecord {
  manager: typeof MANAGER_ID;
  managerPid: number;
  trueforgePid: number;
  exitrampPid: number;
  startedAt: string;
  commit: typeof TRUEFORGE_COMMIT;
  stopRequested?: boolean;
}

interface RuntimeStartReservationRecord {
  manager: typeof MANAGER_ID;
  managerPid: number;
  nonce: string;
  startedAt: string;
}

interface RuntimeStartReservation {
  release: () => Promise<boolean>;
}

interface InstallManifest {
  manager: typeof MANAGER_ID;
  repository: typeof TRUEFORGE_REPOSITORY;
  tag: typeof TRUEFORGE_TAG;
  commit: typeof TRUEFORGE_COMMIT;
  patchSha256: string;
  installedAt: string;
}

interface SpawnedRuntime {
  trueforge: ChildProcess;
  exitramp: ChildProcess;
}

export interface RuntimeStatus {
  installed: boolean;
  installDetail: string;
  trueforge: "running" | "stopped" | "occupied";
  exitramp: "running" | "stopped" | "occupied";
}

export function runtimeLayout(repoRoot: string): RuntimeLayout {
  const root = resolve(repoRoot);
  const managedRoot = join(root, ".trueforge");
  const runtimeDir = join(managedRoot, "runtime");
  return {
    repoRoot: root,
    managedRoot,
    runtimeDir,
    dataDir: join(managedRoot, "data"),
    sqlitePath: join(managedRoot, "data", "db.sqlite"),
    runDir: join(managedRoot, "run"),
    processFile: join(managedRoot, "run", "processes.json"),
    startLockFile: join(managedRoot, "run", "start.lock"),
    installManifestPath: join(managedRoot, "runtime.json"),
    runtimeMarkerPath: join(runtimeDir, ".exitramp-managed-runtime.json"),
    patchPath: join(root, PATCH_RELATIVE_PATH),
    evidenceDir: join(root, ".exitramp", "evidence"),
  };
}

function assertInside(parent: string, target: string, label: string): void {
  const rel = relative(resolve(parent), resolve(target));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} must be a child of ${parent}.`);
  }
}

export function assertManagedLayout(layout: RuntimeLayout): void {
  assertInside(layout.repoRoot, layout.managedRoot, "TrueForge managed root");
  assertInside(layout.managedRoot, layout.runtimeDir, "TrueForge runtime directory");
  assertInside(layout.managedRoot, layout.dataDir, "TrueForge data directory");
  assertInside(layout.repoRoot, layout.evidenceDir, "ExitRamp evidence directory");
  if (basename(layout.runtimeDir) !== "runtime" || basename(layout.managedRoot) !== ".trueforge") {
    throw new Error("Refusing to manage a TrueForge checkout outside .trueforge/runtime.");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function executable(name: "git" | "pnpm"): string {
  return process.platform === "win32" && name === "pnpm" ? "pnpm.cmd" : name;
}

export function commandInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  commandProcessor = process.env.ComSpec ?? "cmd.exe",
): { command: string; args: string[] } {
  if (platform === "win32" && command.toLowerCase().endsWith(".cmd")) {
    return {
      command: commandProcessor,
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { command, args: [...args] };
}

async function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; quiet?: boolean },
): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const invocation = commandInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", chunk => {
      stderr += String(chunk);
    });
    child.once("error", error => {
      reject(new Error(`Could not run ${command}: ${error.message}`));
    });
    child.once("exit", code => {
      if (code === 0) {
        resolvePromise(stdout.trim());
        return;
      }
      const detail = stderr.trim() || stdout.trim();
      reject(new Error(
        `${command} ${args.join(" ")} failed with exit code ${String(code)}${
          detail === "" ? "." : `: ${detail.slice(0, 800)}`
        }`,
      ));
    });
  });
}

function parseVersion(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value.trim());
  if (match === null) throw new Error(`Could not parse version "${value.trim()}".`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < actual.length; index += 1) {
    const current = actual[index] ?? 0;
    const required = minimum[index] ?? 0;
    if (current > required) return true;
    if (current < required) return false;
  }
  return true;
}

export async function checkRuntimePrerequisites(repoRoot: string): Promise<void> {
  const nodeVersion = parseVersion(process.versions.node);
  if (!versionAtLeast(nodeVersion, [22, 13, 0])) {
    throw new Error(
      `Node.js 22.13 or newer is required; this terminal is using ${process.versions.node}.`,
    );
  }
  const gitVersion = await run(executable("git"), ["--version"], { cwd: repoRoot, quiet: true });
  if (!gitVersion.startsWith("git version ")) {
    throw new Error(`Git returned an unexpected version response: ${gitVersion}`);
  }
  const pnpmVersionText = await run(executable("pnpm"), ["--version"], {
    cwd: repoRoot,
    quiet: true,
  });
  const pnpmVersion = parseVersion(pnpmVersionText);
  if (pnpmVersion[0] !== 11) {
    throw new Error(`pnpm 11 is required; this terminal is using ${pnpmVersionText}.`);
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function currentPatchSha(layout: RuntimeLayout): Promise<string> {
  if (!(await exists(layout.patchPath))) {
    throw new Error(
      `The pinned TrueForge patch is missing: ${layout.patchPath}. Pull the latest ExitRamp main branch.`,
    );
  }
  return await sha256(layout.patchPath);
}

async function assertOwnedRuntime(layout: RuntimeLayout): Promise<void> {
  if (!(await exists(layout.runtimeMarkerPath))) {
    throw new Error(
      `${layout.runtimeDir} exists without ExitRamp's ownership marker. `
      + "Refusing to alter it; move that directory and run the install again.",
    );
  }
  const marker = await readJson<{ manager?: string }>(layout.runtimeMarkerPath);
  if (marker.manager !== MANAGER_ID) {
    throw new Error(`Refusing to alter an unrecognized checkout at ${layout.runtimeDir}.`);
  }
}

export async function verifyRuntimeInstallation(
  layout: RuntimeLayout,
): Promise<{ valid: boolean; detail: string }> {
  assertManagedLayout(layout);
  if (!(await exists(layout.runtimeDir)) || !(await exists(layout.installManifestPath))) {
    return { valid: false, detail: "not installed" };
  }
  try {
    await assertOwnedRuntime(layout);
    const manifest = await readJson<Partial<InstallManifest>>(layout.installManifestPath);
    const patchSha256 = await currentPatchSha(layout);
    if (
      manifest.manager !== MANAGER_ID
      || manifest.repository !== TRUEFORGE_REPOSITORY
      || manifest.tag !== TRUEFORGE_TAG
      || manifest.commit !== TRUEFORGE_COMMIT
      || manifest.patchSha256 !== patchSha256
    ) {
      return { valid: false, detail: "managed runtime metadata does not match this ExitRamp build" };
    }
    const head = await run(executable("git"), ["rev-parse", "HEAD"], {
      cwd: layout.runtimeDir,
      quiet: true,
    });
    if (head !== TRUEFORGE_COMMIT) {
      return { valid: false, detail: `source commit is ${head}, expected ${TRUEFORGE_COMMIT}` };
    }
    await run(executable("git"), [
      "apply",
      "--unidiff-zero",
      "--reverse",
      "--check",
      layout.patchPath,
    ], {
      cwd: layout.runtimeDir,
      quiet: true,
    });
    if (!(await exists(join(layout.runtimeDir, "packages", "trueforge", "dist", "main.js")))) {
      return { valid: false, detail: "patched source exists but the TrueForge build is missing" };
    }
    return { valid: true, detail: `patched TrueForge ${TRUEFORGE_TAG} at ${TRUEFORGE_COMMIT}` };
  } catch (error) {
    return {
      valid: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function buildTrueForge(runtimeDir: string): Promise<void> {
  const pnpm = executable("pnpm");
  await run(pnpm, ["install", "--frozen-lockfile"], { cwd: runtimeDir });
  await run(pnpm, ["--filter", "@truefoundry/trueforge-core", "build"], { cwd: runtimeDir });
  await run(pnpm, ["--filter", "@truefoundry/trueforge-sdk", "build"], { cwd: runtimeDir });

  await rm(join(runtimeDir, "packages", "trueforge-ui", "dist"), {
    recursive: true,
    force: true,
  });
  await run(pnpm, [
    "--filter",
    "@truefoundry/trueforge-ui",
    "exec",
    "tailwindcss",
    "--input",
    "src/build-styles.css",
    "--output",
    "dist/styles.css",
    "--minify",
  ], { cwd: runtimeDir });
  await run(pnpm, ["--filter", "@truefoundry/trueforge-ui", "exec", "tsup"], {
    cwd: runtimeDir,
  });

  await rm(join(runtimeDir, "packages", "frontend", "dist"), { recursive: true, force: true });
  await run(pnpm, ["--filter", "frontend", "exec", "tsc", "--noEmit"], { cwd: runtimeDir });
  await run(pnpm, ["--filter", "frontend", "exec", "vite", "build"], { cwd: runtimeDir });

  await run(pnpm, ["--filter", "@truefoundry/trueforge", "run", "build:gen"], {
    cwd: runtimeDir,
  });
  await run(pnpm, ["--filter", "@truefoundry/trueforge", "exec", "tsc", "--noEmit"], {
    cwd: runtimeDir,
  });
  await rm(join(runtimeDir, "packages", "trueforge", "dist"), { recursive: true, force: true });
  await run(pnpm, ["--filter", "@truefoundry/trueforge", "exec", "tsup"], {
    cwd: runtimeDir,
  });
  await run(pnpm, ["--filter", "@truefoundry/trueforge", "run", "build:frontend-assets"], {
    cwd: runtimeDir,
  });
}

export async function installTrueForgeRuntime(layout: RuntimeLayout): Promise<void> {
  assertManagedLayout(layout);
  await assertRuntimeStoppedForInstall(layout);
  await checkRuntimePrerequisites(layout.repoRoot);
  const patchSha256 = await currentPatchSha(layout);
  const current = await verifyRuntimeInstallation(layout);
  if (current.valid) {
    process.stdout.write(`TrueForge runtime already installed: ${current.detail}.\n`);
    return;
  }

  await mkdir(layout.managedRoot, { recursive: true });
  if (await exists(layout.runtimeDir)) await assertOwnedRuntime(layout);

  const stagingDir = join(layout.managedRoot, `runtime.installing-${String(process.pid)}`);
  assertInside(layout.managedRoot, stagingDir, "TrueForge staging directory");
  if (await exists(stagingDir)) {
    throw new Error(`A previous install staging directory still exists: ${stagingDir}`);
  }

  try {
    process.stdout.write(`Cloning pinned TrueForge ${TRUEFORGE_TAG}...\n`);
    await run(executable("git"), [
      "clone",
      "--depth",
      "1",
      "--branch",
      TRUEFORGE_TAG,
      "--single-branch",
      TRUEFORGE_REPOSITORY,
      stagingDir,
    ], { cwd: layout.managedRoot });
    const head = await run(executable("git"), ["rev-parse", "HEAD"], {
      cwd: stagingDir,
      quiet: true,
    });
    if (head !== TRUEFORGE_COMMIT) {
      throw new Error(`Pinned tag resolved to ${head}; expected ${TRUEFORGE_COMMIT}.`);
    }
    await run(executable("git"), ["apply", "--unidiff-zero", "--check", layout.patchPath], {
      cwd: stagingDir,
      quiet: true,
    });
    await run(executable("git"), ["apply", "--unidiff-zero", layout.patchPath], {
      cwd: stagingDir,
    });
    process.stdout.write("Building the patched TrueForge runtime...\n");
    await buildTrueForge(stagingDir);

    const marker: InstallManifest = {
      manager: MANAGER_ID,
      repository: TRUEFORGE_REPOSITORY,
      tag: TRUEFORGE_TAG,
      commit: TRUEFORGE_COMMIT,
      patchSha256,
      installedAt: new Date().toISOString(),
    };
    await writeJson(join(stagingDir, ".exitramp-managed-runtime.json"), marker);

    if (await exists(layout.runtimeDir)) {
      const previousDir = join(layout.managedRoot, `runtime.previous-${String(process.pid)}`);
      assertInside(layout.managedRoot, previousDir, "TrueForge previous runtime directory");
      await rename(layout.runtimeDir, previousDir);
      try {
        await rename(stagingDir, layout.runtimeDir);
      } catch (error) {
        await rename(previousDir, layout.runtimeDir);
        throw error;
      }
      await rm(previousDir, { recursive: true, force: true });
    } else {
      await rename(stagingDir, layout.runtimeDir);
    }
    await writeJson(layout.installManifestPath, marker);
    process.stdout.write(`Installed patched TrueForge in ${layout.runtimeDir}.\n`);
  } catch (error) {
    if (await exists(stagingDir)) await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessRecord(layout: RuntimeLayout): Promise<RuntimeProcessRecord | undefined> {
  if (!(await exists(layout.processFile))) return undefined;
  try {
    const record = await readJson<RuntimeProcessRecord>(layout.processFile);
    return record.manager === MANAGER_ID ? record : undefined;
  } catch {
    return undefined;
  }
}

function runtimeRecordHasLiveProcess(
  record: RuntimeProcessRecord | undefined,
): boolean {
  return record !== undefined
    && [record.managerPid, record.trueforgePid, record.exitrampPid].some(isAlive);
}

async function assertRuntimeStoppedForInstall(layout: RuntimeLayout): Promise<void> {
  if (await exists(layout.startLockFile)) {
    const reservation = await readStartReservation(layout);
    if (reservation === undefined) {
      throw new Error(
        `Cannot install while the start reservation at ${layout.startLockFile} is unreadable. `
        + "If no launcher is running, remove that file and try again.",
      );
    }
    if (reservation.managerPid !== process.pid && isAlive(reservation.managerPid)) {
      throw new Error(
        `Cannot install while another local-stack start is in progress (manager PID ${String(reservation.managerPid)}).`,
      );
    }
  }

  const record = await readProcessRecord(layout);
  if (runtimeRecordHasLiveProcess(record)) {
    throw new Error(
      "Cannot install or replace TrueForge while the ExitRamp-managed local stack is running. "
      + "Run pnpm trueforge:runtime:stop first.",
    );
  }
  const [trueforgeHealth, exitrampHealth] = await Promise.all([
    trueforgeHealthy(),
    exitrampHealthy(),
  ]);
  if (trueforgeHealth || exitrampHealth) {
    throw new Error(
      "Cannot install or replace TrueForge while localhost runtime services are running. "
      + "Stop the existing services first.",
    );
  }
}

function sameProcessRecordOwner(
  actual: RuntimeProcessRecord,
  expected: Pick<RuntimeProcessRecord, "managerPid" | "startedAt">,
): boolean {
  return actual.manager === MANAGER_ID
    && actual.managerPid === expected.managerPid
    && actual.startedAt === expected.startedAt;
}

export async function removeProcessRecordIfOwned(
  layout: RuntimeLayout,
  expected: Pick<RuntimeProcessRecord, "managerPid" | "startedAt">,
): Promise<boolean> {
  const current = await readProcessRecord(layout);
  if (current === undefined || !sameProcessRecordOwner(current, expected)) return false;
  await rm(layout.processFile, { force: true });
  return true;
}

async function readStartReservation(
  layout: RuntimeLayout,
): Promise<RuntimeStartReservationRecord | undefined> {
  if (!(await exists(layout.startLockFile))) return undefined;
  try {
    const record = await readJson<RuntimeStartReservationRecord>(layout.startLockFile);
    if (
      record.manager !== MANAGER_ID
      || !Number.isSafeInteger(record.managerPid)
      || record.managerPid <= 0
      || typeof record.nonce !== "string"
      || record.nonce.length === 0
      || typeof record.startedAt !== "string"
    ) {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

async function removeStartReservationIfOwned(
  layout: RuntimeLayout,
  expected: RuntimeStartReservationRecord,
): Promise<boolean> {
  const current = await readStartReservation(layout);
  if (
    current === undefined
    || current.managerPid !== expected.managerPid
    || current.nonce !== expected.nonce
  ) {
    return false;
  }
  await rm(layout.startLockFile, { force: true });
  return true;
}

function errorHasCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

export async function acquireRuntimeStartReservation(
  layout: RuntimeLayout,
): Promise<RuntimeStartReservation> {
  assertManagedLayout(layout);
  await mkdir(layout.runDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(layout.startLockFile, "wx");
    } catch (error) {
      if (!errorHasCode(error, "EEXIST")) throw error;
      const existing = await readStartReservation(layout);
      if (existing === undefined) {
        throw new Error(
          `A start reservation already exists at ${layout.startLockFile}, but it is unreadable. `
          + "If no launcher is running, remove that file and try again.",
        );
      }
      if (isAlive(existing.managerPid)) {
        throw new Error(
          `Another ExitRamp local-stack start is already in progress (manager PID ${String(existing.managerPid)}).`,
        );
      }
      if (attempt === 1) {
        throw new Error("Could not reclaim a stale ExitRamp local-stack start reservation.");
      }
      const latest = await readStartReservation(layout);
      if (
        latest === undefined
        || latest.managerPid !== existing.managerPid
        || latest.nonce !== existing.nonce
      ) {
        continue;
      }
      await rm(layout.startLockFile, { force: true });
      continue;
    }

    const record: RuntimeStartReservationRecord = {
      manager: MANAGER_ID,
      managerPid: process.pid,
      nonce: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(layout.startLockFile, { force: true });
      throw error;
    }
    return {
      release: async () => await removeStartReservationIfOwned(layout, record),
    };
  }

  throw new Error("Could not reserve the ExitRamp local-stack start.");
}

export function runtimeEvidenceDirectory(
  layout: RuntimeLayout,
  configured = process.env.EXITRAMP_EVIDENCE_DIR,
): string {
  return configured === undefined || configured.length === 0
    ? layout.evidenceDir
    : resolve(layout.repoRoot, configured);
}

async function waitUntilStopped(pids: readonly number[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pids.some(isAlive)) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
}

export async function stopTrueForgeRuntime(layout: RuntimeLayout): Promise<void> {
  assertManagedLayout(layout);
  const record = await readProcessRecord(layout);
  if (record === undefined) {
    process.stdout.write("No ExitRamp-managed local runtime is recorded.\n");
    return;
  }

  const childPids = [record.exitrampPid, record.trueforgePid];
  const externalManager = record.managerPid !== process.pid && isAlive(record.managerPid);
  if (externalManager) {
    const current = await readProcessRecord(layout);
    if (current !== undefined && sameProcessRecordOwner(current, record)) {
      await writeJson(layout.processFile, { ...current, stopRequested: true });
    }
  }
  for (const pid of childPids) {
    if (isAlive(pid)) process.kill(pid, "SIGTERM");
  }
  await waitUntilStopped(childPids);
  if (externalManager) {
    await waitUntilStopped([record.managerPid]);
  }
  if (!externalManager || !isAlive(record.managerPid)) {
    await removeProcessRecordIfOwned(layout, record);
  }
  process.stdout.write("Stopped the ExitRamp-managed TrueForge and MCP processes.\n");
}

export function runtimeStopWasRequested(record: RuntimeProcessRecord | undefined): boolean {
  return record?.manager === MANAGER_ID && record.stopRequested === true;
}

async function probe(
  url: string,
  validate: (body: string) => boolean,
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok && validate(await response.text());
  } catch {
    return false;
  }
}

async function trueforgeHealthy(): Promise<boolean> {
  return await probe(`${TRUEFORGE_URL}/healthz`, body => body.trim() === "OK!");
}

async function exitrampHealthy(): Promise<boolean> {
  return await probe(`${EXITRAMP_URL}/healthz`, body => {
    try {
      const parsed = JSON.parse(body) as { status?: string; service?: string };
      return parsed.status === "ok" && parsed.service === "exitramp-mcp";
    } catch {
      return false;
    }
  });
}

export async function getRuntimeStatus(layout: RuntimeLayout): Promise<RuntimeStatus> {
  const installation = await verifyRuntimeInstallation(layout);
  const record = await readProcessRecord(layout);
  const [trueforgeHealth, exitrampHealth] = await Promise.all([
    trueforgeHealthy(),
    exitrampHealthy(),
  ]);
  const trueforgeManaged = record !== undefined && isAlive(record.trueforgePid);
  const exitrampManaged = record !== undefined && isAlive(record.exitrampPid);
  return {
    installed: installation.valid,
    installDetail: installation.detail,
    trueforge: trueforgeHealth ? (trueforgeManaged ? "running" : "occupied") : "stopped",
    exitramp: exitrampHealth ? (exitrampManaged ? "running" : "occupied") : "stopped",
  };
}

async function waitForHealth(
  name: string,
  check: () => Promise<boolean>,
  child: ChildProcess,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited before becoming ready (exit ${String(child.exitCode)}).`);
    }
    if (await check()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 400));
  }
  throw new Error(`${name} did not become ready within ${String(timeoutMs / 1_000)} seconds.`);
}

function launchNode(
  entrypoint: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  return spawn(process.execPath, [entrypoint, ...args], {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: "inherit",
  });
}

async function terminateRuntime(runtime: SpawnedRuntime): Promise<void> {
  for (const child of [runtime.exitramp, runtime.trueforge]) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await Promise.all([runtime.exitramp, runtime.trueforge].map(async child => {
    if (child.exitCode !== null) return;
    await Promise.race([
      new Promise<void>(resolvePromise => child.once("exit", () => resolvePromise())),
      new Promise<void>(resolvePromise => setTimeout(resolvePromise, 5_000)),
    ]);
  }));
}

export async function startTrueForgeRuntime(layout: RuntimeLayout): Promise<void> {
  assertManagedLayout(layout);
  const reservation = await acquireRuntimeStartReservation(layout);
  let runtime: SpawnedRuntime | undefined;
  let ownedRecord: RuntimeProcessRecord | undefined;
  let evidenceDir = layout.evidenceDir;

  try {
    const existingRecord = await readProcessRecord(layout);
    if (runtimeRecordHasLiveProcess(existingRecord)) {
      throw new Error(
        "Cannot start: another ExitRamp-managed local stack is already starting or running.",
      );
    }

    await checkRuntimePrerequisites(layout.repoRoot);
    const installation = await verifyRuntimeInstallation(layout);
    if (!installation.valid) {
      if (installation.detail !== "not installed") {
        throw new Error(
          `The managed TrueForge runtime is not usable: ${installation.detail}. `
          + "Run pnpm trueforge:runtime:install before starting it.",
        );
      }
      await installTrueForgeRuntime(layout);
    }

    const initialStatus = await getRuntimeStatus(layout);
    if (initialStatus.trueforge !== "stopped" || initialStatus.exitramp !== "stopped") {
      throw new Error(
        `Cannot start: TrueForge port is ${initialStatus.trueforge} and ExitRamp port is ${initialStatus.exitramp}. `
        + "Stop the existing localhost services first.",
      );
    }

    evidenceDir = runtimeEvidenceDirectory(layout);
    await mkdir(dirname(layout.sqlitePath), { recursive: true });
    await mkdir(layout.runDir, { recursive: true });
    await mkdir(evidenceDir, { recursive: true });

    const trueforgeEntry = join(layout.runtimeDir, "packages", "trueforge", "dist", "main.js");
    const tsxEntry = join(layout.repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const exitrampEntry = join(layout.repoRoot, "src", "mcp", "server.ts");
    for (const requiredPath of [trueforgeEntry, tsxEntry, exitrampEntry]) {
      if (!(await exists(requiredPath))) {
        throw new Error(`Required runtime file is missing: ${requiredPath}`);
      }
    }

    runtime = {
      trueforge: launchNode(trueforgeEntry, [], join(layout.runtimeDir, "packages", "trueforge"), {
        ...process.env,
        HOST: "127.0.0.1",
        NODE_ENV: "production",
        PORT: "8790",
        SQLITE_PATH: layout.sqlitePath,
        STANDALONE: "true",
      }),
      exitramp: launchNode(tsxEntry, [exitrampEntry], layout.repoRoot, {
        ...process.env,
        EXITRAMP_EVIDENCE_DIR: evidenceDir,
        PORT: "8788",
      }),
    };

    if (runtime.trueforge.pid === undefined || runtime.exitramp.pid === undefined) {
      throw new Error("Node did not return process IDs for the local services.");
    }
    const record: RuntimeProcessRecord = {
      manager: MANAGER_ID,
      managerPid: process.pid,
      trueforgePid: runtime.trueforge.pid,
      exitrampPid: runtime.exitramp.pid,
      startedAt: new Date().toISOString(),
      commit: TRUEFORGE_COMMIT,
    };
    await writeJson(layout.processFile, record);
    ownedRecord = record;
  } catch (error) {
    if (runtime !== undefined) await terminateRuntime(runtime);
    if (ownedRecord !== undefined) {
      await removeProcessRecordIfOwned(layout, ownedRecord);
    }
    throw error;
  } finally {
    await reservation.release();
  }

  const startedRuntime = runtime;
  const startedRecord = ownedRecord;
  if (startedRuntime === undefined || startedRecord === undefined) {
    throw new Error("The local runtime did not finish starting.");
  }
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await terminateRuntime(startedRuntime);
    await removeProcessRecordIfOwned(layout, startedRecord);
  };
  const onSignal = (): void => {
    void stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await Promise.all([
      waitForHealth("TrueForge", trueforgeHealthy, startedRuntime.trueforge),
      waitForHealth("ExitRamp MCP", exitrampHealthy, startedRuntime.exitramp),
    ]);
    process.stdout.write("\nExitRamp local stack is ready.\n");
    process.stdout.write(`TrueForge: ${TRUEFORGE_URL}\n`);
    process.stdout.write(`ExitRamp MCP: ${EXITRAMP_URL}/mcp\n`);
    process.stdout.write(`TrueForge data: ${layout.sqlitePath}\n`);
    process.stdout.write(`ExitRamp evidence: ${evidenceDir}\n`);
    process.stdout.write("Press Ctrl+C to stop both processes.\n\n");

    await Promise.race([startedRuntime.trueforge, startedRuntime.exitramp].map(async child => {
      await new Promise<void>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolvePromise());
      });
    }));
    const latestRecord = await readProcessRecord(layout);
    if (!stopping && !runtimeStopWasRequested(latestRecord)) {
      throw new Error("One local service exited; both services have been stopped.");
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await stop();
  }
}

export function formatRuntimeStatus(status: RuntimeStatus, layout: RuntimeLayout): string {
  return [
    `Patched TrueForge: ${status.installed ? "installed" : "not ready"} (${status.installDetail})`,
    `TrueForge ${TRUEFORGE_URL}: ${status.trueforge}`,
    `ExitRamp ${EXITRAMP_URL}: ${status.exitramp}`,
    `Persistent TrueForge data: ${layout.sqlitePath}`,
    `Persistent ExitRamp evidence: ${runtimeEvidenceDirectory(layout)}`,
  ].join("\n");
}
