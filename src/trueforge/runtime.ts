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
const LIFECYCLE_HEARTBEAT_MS = 500;
const LIFECYCLE_LEASE_MS = 5_000;
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
  stopRequestFile: string;
  startLockFile: string;
  installManifestPath: string;
  runtimeMarkerPath: string;
  patchPath: string;
  evidenceDir: string;
}

export interface RuntimeProcessRecord {
  manager: typeof MANAGER_ID;
  instanceId: string;
  managerPid: number;
  trueforgePid: number;
  exitrampPid: number;
  startedAt: string;
  heartbeatAt: string;
  commit: typeof TRUEFORGE_COMMIT;
  stopRequested?: boolean;
}

type RuntimeLifecycleOperation = "install" | "start" | "stop";

interface RuntimeLifecycleReservationRecord {
  manager: typeof MANAGER_ID;
  managerPid: number;
  nonce: string;
  operation: RuntimeLifecycleOperation;
  startedAt: string;
}

interface RuntimeLifecycleLeaseRecord {
  manager: typeof MANAGER_ID;
  managerPid: number;
  nonce: string;
  heartbeatAt: string;
}

interface RuntimeLifecycleReservation {
  assertOwned: () => Promise<void>;
  release: () => Promise<boolean>;
}

interface RuntimeStopRequestRecord {
  manager: typeof MANAGER_ID;
  instanceId: string;
  requestedAt: string;
}

interface InstallManifest {
  manager: typeof MANAGER_ID;
  repository: typeof TRUEFORGE_REPOSITORY;
  tag: typeof TRUEFORGE_TAG;
  commit: typeof TRUEFORGE_COMMIT;
  patchSha256: string;
  installedAt: string;
}

export interface ManagedChildProcess {
  name: string;
  child: ChildProcess;
  spawnError?: Error;
  spawned: Promise<void>;
  settled: Promise<void>;
}

interface SpawnedRuntime {
  trueforge: ManagedChildProcess;
  exitramp: ManagedChildProcess;
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
    stopRequestFile: join(managedRoot, "run", "stop-request.json"),
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

async function writeRuntimeStateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
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

async function installTrueForgeRuntimeLocked(
  layout: RuntimeLayout,
  reservation: RuntimeLifecycleReservation,
): Promise<void> {
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

    await reservation.assertOwned();
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

export async function installTrueForgeRuntime(layout: RuntimeLayout): Promise<void> {
  assertManagedLayout(layout);
  const reservation = await acquireRuntimeLifecycleReservation(layout, "install");
  try {
    await installTrueForgeRuntimeLocked(layout, reservation);
  } finally {
    if (!(await reservation.release())) {
      throw new Error("The install lifecycle reservation was lost before it could be released.");
    }
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
    if (
      record.manager !== MANAGER_ID
      || typeof record.instanceId !== "string"
      || record.instanceId.length === 0
      || !Number.isSafeInteger(record.managerPid)
      || record.managerPid <= 0
      || !Number.isSafeInteger(record.trueforgePid)
      || record.trueforgePid <= 0
      || !Number.isSafeInteger(record.exitrampPid)
      || record.exitrampPid <= 0
      || typeof record.startedAt !== "string"
      || !Number.isFinite(Date.parse(record.startedAt))
      || typeof record.heartbeatAt !== "string"
      || !Number.isFinite(Date.parse(record.heartbeatAt))
      || record.commit !== TRUEFORGE_COMMIT
    ) {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

async function readStopRequest(
  layout: RuntimeLayout,
): Promise<RuntimeStopRequestRecord | undefined> {
  if (!(await exists(layout.stopRequestFile))) return undefined;
  try {
    const request = await readJson<RuntimeStopRequestRecord>(layout.stopRequestFile);
    if (
      request.manager !== MANAGER_ID
      || typeof request.instanceId !== "string"
      || request.instanceId.length === 0
      || typeof request.requestedAt !== "string"
      || !Number.isFinite(Date.parse(request.requestedAt))
    ) {
      return undefined;
    }
    return request;
  } catch {
    return undefined;
  }
}

async function removeStopRequestIfOwned(
  layout: RuntimeLayout,
  instanceId: string,
): Promise<boolean> {
  const request = await readStopRequest(layout);
  if (request === undefined || request.instanceId !== instanceId) return false;
  await rm(layout.stopRequestFile, { force: true });
  return true;
}

function leaseIsFresh(heartbeatAt: string, now = Date.now()): boolean {
  const age = now - Date.parse(heartbeatAt);
  return Number.isFinite(age) && age >= -LIFECYCLE_LEASE_MS && age <= LIFECYCLE_LEASE_MS;
}

export function runtimeManagerLeaseIsActive(
  record: RuntimeProcessRecord | undefined,
  now = Date.now(),
): boolean {
  return record !== undefined
    && leaseIsFresh(record.heartbeatAt, now)
    && isAlive(record.managerPid);
}

async function assertRuntimeStoppedForInstall(layout: RuntimeLayout): Promise<void> {
  const processFileExists = await exists(layout.processFile);
  const record = await readProcessRecord(layout);
  if (runtimeManagerLeaseIsActive(record)) {
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
      `Cannot install or replace TrueForge while localhost runtime services are running${processFileExists && record === undefined ? " with an unverifiable legacy process record" : ""}. `
      + "Stop the existing services first.",
    );
  }
  if (processFileExists) {
    if (record === undefined) {
      await rm(layout.processFile, { force: true });
    } else {
      await removeProcessRecordIfOwned(layout, record);
    }
  }
  await rm(layout.stopRequestFile, { force: true });
}

function sameProcessRecordOwner(
  actual: RuntimeProcessRecord,
  expected: Pick<RuntimeProcessRecord, "instanceId" | "managerPid">,
): boolean {
  return actual.manager === MANAGER_ID
    && actual.instanceId === expected.instanceId
    && actual.managerPid === expected.managerPid;
}

export async function removeProcessRecordIfOwned(
  layout: RuntimeLayout,
  expected: Pick<RuntimeProcessRecord, "instanceId" | "managerPid">,
): Promise<boolean> {
  const current = await readProcessRecord(layout);
  if (current === undefined || !sameProcessRecordOwner(current, expected)) return false;
  await rm(layout.processFile, { force: true });
  return true;
}

async function readLifecycleReservation(
  layout: RuntimeLayout,
): Promise<RuntimeLifecycleReservationRecord | undefined> {
  if (!(await exists(layout.startLockFile))) return undefined;
  try {
    const record = await readJson<RuntimeLifecycleReservationRecord>(layout.startLockFile);
    if (
      record.manager !== MANAGER_ID
      || !Number.isSafeInteger(record.managerPid)
      || record.managerPid <= 0
      || typeof record.nonce !== "string"
      || record.nonce.length === 0
      || !["install", "start", "stop"].includes(record.operation)
      || typeof record.startedAt !== "string"
      || !Number.isFinite(Date.parse(record.startedAt))
    ) {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

function lifecycleLeasePath(layout: RuntimeLayout, nonce: string): string {
  return join(layout.runDir, `lifecycle-${nonce}.lease.json`);
}

async function readLifecycleLease(
  layout: RuntimeLayout,
  reservation: RuntimeLifecycleReservationRecord,
): Promise<RuntimeLifecycleLeaseRecord | undefined> {
  const path = lifecycleLeasePath(layout, reservation.nonce);
  if (!(await exists(path))) return undefined;
  try {
    const lease = await readJson<RuntimeLifecycleLeaseRecord>(path);
    if (
      lease.manager !== MANAGER_ID
      || lease.managerPid !== reservation.managerPid
      || lease.nonce !== reservation.nonce
      || typeof lease.heartbeatAt !== "string"
      || !Number.isFinite(Date.parse(lease.heartbeatAt))
    ) {
      return undefined;
    }
    return lease;
  } catch {
    return undefined;
  }
}

async function lifecycleReservationIsActive(
  layout: RuntimeLayout,
  reservation: RuntimeLifecycleReservationRecord,
): Promise<boolean> {
  if (!isAlive(reservation.managerPid)) return false;
  const lease = await readLifecycleLease(layout, reservation);
  return lease === undefined
    ? leaseIsFresh(reservation.startedAt)
    : leaseIsFresh(lease.heartbeatAt);
}

async function removeStartReservationIfOwned(
  layout: RuntimeLayout,
  expected: RuntimeLifecycleReservationRecord,
): Promise<boolean> {
  const current = await readLifecycleReservation(layout);
  if (
    current === undefined
    || current.managerPid !== expected.managerPid
    || current.nonce !== expected.nonce
  ) {
    return false;
  }
  await rm(layout.startLockFile, { force: true });
  await rm(lifecycleLeasePath(layout, expected.nonce), { force: true });
  return true;
}

function errorHasCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

export async function acquireRuntimeStartReservation(
  layout: RuntimeLayout,
  operation: RuntimeLifecycleOperation = "start",
): Promise<RuntimeLifecycleReservation> {
  return await acquireRuntimeLifecycleReservation(layout, operation);
}

export async function acquireRuntimeLifecycleReservation(
  layout: RuntimeLayout,
  operation: RuntimeLifecycleOperation,
): Promise<RuntimeLifecycleReservation> {
  assertManagedLayout(layout);
  await mkdir(layout.runDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(layout.startLockFile, "wx");
    } catch (error) {
      if (!errorHasCode(error, "EEXIST")) throw error;
      const existing = await readLifecycleReservation(layout);
      if (existing === undefined) {
        throw new Error(
          `A lifecycle reservation already exists at ${layout.startLockFile}, but it is unreadable. `
          + "Refusing to guess whether another operation owns it.",
        );
      }
      if (await lifecycleReservationIsActive(layout, existing)) {
        throw new Error(
          `Another ExitRamp lifecycle operation is already in progress (${existing.operation}, manager PID ${String(existing.managerPid)}).`,
        );
      }
      if (attempt === 1) {
        throw new Error("Could not reclaim a stale ExitRamp lifecycle reservation.");
      }
      const latest = await readLifecycleReservation(layout);
      if (
        latest === undefined
        || latest.managerPid !== existing.managerPid
        || latest.nonce !== existing.nonce
      ) {
        continue;
      }
      if (await lifecycleReservationIsActive(layout, latest)) {
        throw new Error(
          `Another ExitRamp lifecycle operation became active while reclaiming the ${latest.operation} reservation.`,
        );
      }
      await rm(layout.startLockFile, { force: true });
      await rm(lifecycleLeasePath(layout, latest.nonce), { force: true });
      continue;
    }

    const now = new Date().toISOString();
    const record: RuntimeLifecycleReservationRecord = {
      manager: MANAGER_ID,
      managerPid: process.pid,
      nonce: randomUUID(),
      operation,
      startedAt: now,
    };
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(layout.startLockFile, { force: true });
      throw error;
    }
    const leasePath = lifecycleLeasePath(layout, record.nonce);
    try {
      await writeRuntimeStateJson(leasePath, {
        manager: MANAGER_ID,
        managerPid: record.managerPid,
        nonce: record.nonce,
        heartbeatAt: now,
      } satisfies RuntimeLifecycleLeaseRecord);
    } catch (error) {
      await removeStartReservationIfOwned(layout, record);
      throw error;
    }

    let released = false;
    let heartbeatError: Error | undefined;
    let heartbeatWork = Promise.resolve();
    const heartbeat = async (): Promise<void> => {
      if (released) return;
      const current = await readLifecycleReservation(layout);
      if (
        current === undefined
        || current.managerPid !== record.managerPid
        || current.nonce !== record.nonce
      ) {
        throw new Error("The ExitRamp lifecycle reservation was lost.");
      }
      if (released) return;
      await writeRuntimeStateJson(leasePath, {
        manager: MANAGER_ID,
        managerPid: record.managerPid,
        nonce: record.nonce,
        heartbeatAt: new Date().toISOString(),
      } satisfies RuntimeLifecycleLeaseRecord);
    };
    const timer = setInterval(() => {
      heartbeatWork = heartbeatWork.then(heartbeat).catch(error => {
        heartbeatError = error instanceof Error ? error : new Error(String(error));
        clearInterval(timer);
      });
    }, LIFECYCLE_HEARTBEAT_MS);
    timer.unref();

    return {
      assertOwned: async () => {
        await heartbeatWork;
        if (heartbeatError !== undefined) throw heartbeatError;
        const current = await readLifecycleReservation(layout);
        if (
          current === undefined
          || current.managerPid !== record.managerPid
          || current.nonce !== record.nonce
        ) {
          throw new Error("The ExitRamp lifecycle reservation is no longer owned by this process.");
        }
        const lease = await readLifecycleLease(layout, record);
        if (lease === undefined || !leaseIsFresh(lease.heartbeatAt)) {
          throw new Error("The ExitRamp lifecycle reservation lease is not current.");
        }
      },
      release: async () => {
        released = true;
        clearInterval(timer);
        await heartbeatWork;
        const removed = await removeStartReservationIfOwned(layout, record);
        await rm(leasePath, { force: true });
        return removed;
      },
    };
  }

  throw new Error("Could not reserve the ExitRamp lifecycle operation.");
}

export function runtimeEvidenceDirectory(
  layout: RuntimeLayout,
  configured = process.env.EXITRAMP_EVIDENCE_DIR,
): string {
  return configured === undefined || configured.length === 0
    ? layout.evidenceDir
    : resolve(layout.repoRoot, configured);
}

async function localhostRuntimeHealth(): Promise<{
  trueforge: boolean;
  exitramp: boolean;
}> {
  const [trueforge, exitramp] = await Promise.all([
    trueforgeHealthy(),
    exitrampHealthy(),
  ]);
  return { trueforge, exitramp };
}

async function waitForManagerShutdown(
  layout: RuntimeLayout,
  expected: RuntimeProcessRecord,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readProcessRecord(layout);
    if (current === undefined || !sameProcessRecordOwner(current, expected)) return true;
    if (!runtimeManagerLeaseIsActive(current)) {
      const health = await localhostRuntimeHealth();
      return !health.trueforge && !health.exitramp;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  return false;
}

export async function stopTrueForgeRuntime(layout: RuntimeLayout): Promise<void> {
  assertManagedLayout(layout);
  const reservation = await acquireRuntimeLifecycleReservation(layout, "stop");
  try {
    const processFileExists = await exists(layout.processFile);
    const record = await readProcessRecord(layout);
    if (record === undefined || !runtimeManagerLeaseIsActive(record)) {
      const health = await localhostRuntimeHealth();
      if (health.trueforge || health.exitramp) {
        throw new Error(
          "Local runtime services are still responding, but their manager lease is not verifiable. "
          + "No persisted PID was signaled and no ownership metadata was deleted.",
        );
      }
      if (processFileExists) await rm(layout.processFile, { force: true });
      await rm(layout.stopRequestFile, { force: true });
      process.stdout.write(
        processFileExists
          ? "Discarded an unverifiable stale runtime record; no process was signaled.\n"
          : "No ExitRamp-managed local runtime is recorded.\n",
      );
      return;
    }

    const current = await readProcessRecord(layout);
    if (
      current === undefined
      || !sameProcessRecordOwner(current, record)
      || !runtimeManagerLeaseIsActive(current)
    ) {
      throw new Error("The runtime manager lease changed before the stop request was recorded.");
    }
    await writeRuntimeStateJson(layout.stopRequestFile, {
      manager: MANAGER_ID,
      instanceId: current.instanceId,
      requestedAt: new Date().toISOString(),
    });

    if (!(await waitForManagerShutdown(layout, record))) {
      throw new Error(
        "The verified runtime manager did not stop within 15 seconds. "
        + "Ownership metadata was retained and no child PID was signaled externally.",
      );
    }
    const health = await localhostRuntimeHealth();
    if (health.trueforge || health.exitramp) {
      throw new Error(
        "The runtime manager lease ended, but one or more localhost services remain active. "
        + "No success was reported and no remaining PID was signaled.",
      );
    }
    await removeProcessRecordIfOwned(layout, record);
    await removeStopRequestIfOwned(layout, record.instanceId);
    process.stdout.write("Stopped the ExitRamp-managed TrueForge and MCP processes.\n");
  } finally {
    if (!(await reservation.release())) {
      throw new Error("The stop lifecycle reservation was lost before it could be released.");
    }
  }
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
  const verifiedManager = runtimeManagerLeaseIsActive(record);
  return {
    installed: installation.valid,
    installDetail: installation.detail,
    trueforge: trueforgeHealth ? (verifiedManager ? "running" : "occupied") : "stopped",
    exitramp: exitrampHealth ? (verifiedManager ? "running" : "occupied") : "stopped",
  };
}

function managedChildHasExited(managed: ManagedChildProcess): boolean {
  return managed.child.exitCode !== null
    || managed.child.signalCode !== null
    || (managed.spawnError !== undefined && managed.child.pid === undefined);
}

export async function waitForManagedChildExit(
  managed: ManagedChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (managedChildHasExited(managed)) return true;
  return await new Promise<boolean>(resolvePromise => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    managed.settled.then(() => {
      clearTimeout(timer);
      resolvePromise(true);
    }).catch(() => {
      clearTimeout(timer);
      resolvePromise(false);
    });
  });
}

export async function waitForManagedChildHealth(
  managed: ManagedChildProcess,
  check: () => Promise<boolean>,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (managed.spawnError !== undefined) {
      throw new Error(`${managed.name} failed to spawn: ${managed.spawnError.message}`);
    }
    if (managedChildHasExited(managed)) {
      throw new Error(
        `${managed.name} exited before becoming ready (exit ${String(managed.child.exitCode)}, signal ${String(managed.child.signalCode)}).`,
      );
    }
    if (await check()) return;
    await Promise.race([
      managed.settled,
      new Promise(resolvePromise => setTimeout(resolvePromise, 400)),
    ]);
  }
  if (managed.spawnError !== undefined) {
    throw new Error(`${managed.name} failed to spawn: ${managed.spawnError.message}`);
  }
  throw new Error(
    `${managed.name} did not become ready within ${String(timeoutMs / 1_000)} seconds.`,
  );
}

export function launchManagedProcess(
  name: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ManagedChildProcess {
  const child = spawn(command, [...args], {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: "inherit",
  });
  let resolveSpawn!: () => void;
  let rejectSpawn!: (error: Error) => void;
  const spawned = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveSpawn = resolvePromise;
    rejectSpawn = rejectPromise;
  });
  void spawned.catch(() => undefined);
  const managed: ManagedChildProcess = {
    name,
    child,
    spawned,
    settled: new Promise<void>(resolvePromise => {
      child.once("close", () => resolvePromise());
    }),
  };
  child.once("spawn", resolveSpawn);
  child.on("error", error => {
    managed.spawnError = error;
    rejectSpawn(error);
  });
  return managed;
}

function launchNode(
  name: string,
  entrypoint: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ManagedChildProcess {
  return launchManagedProcess(name, process.execPath, [entrypoint, ...args], cwd, env);
}

export async function terminateManagedChildren(
  children: readonly ManagedChildProcess[],
  gracefulTimeoutMs = 5_000,
  forceTimeoutMs = 5_000,
): Promise<void> {
  for (const managed of children) {
    if (!managedChildHasExited(managed)) {
      try {
        managed.child.kill("SIGTERM");
      } catch {
        // The exit verification below decides whether cleanup succeeded.
      }
    }
  }
  await Promise.all(children.map(async managed => {
    await waitForManagedChildExit(managed, gracefulTimeoutMs);
  }));

  const remaining = children.filter(managed => !managedChildHasExited(managed));
  for (const managed of remaining) {
    try {
      managed.child.kill("SIGKILL");
    } catch {
      // The exit verification below decides whether cleanup succeeded.
    }
  }
  await Promise.all(remaining.map(async managed => {
    await waitForManagedChildExit(managed, forceTimeoutMs);
  }));

  const survivors = children.filter(managed => !managedChildHasExited(managed));
  if (survivors.length > 0) {
    throw new Error(
      `Could not stop managed process${survivors.length === 1 ? "" : "es"}: ${survivors.map(child => child.name).join(", ")}. Ownership metadata was retained.`,
    );
  }
}

async function terminateRuntime(runtime: SpawnedRuntime): Promise<void> {
  await terminateManagedChildren([runtime.exitramp, runtime.trueforge]);
}

interface RuntimeManagerHeartbeat {
  failure: Promise<never>;
  stop: () => Promise<void>;
}

function beginRuntimeManagerHeartbeat(
  layout: RuntimeLayout,
  owner: RuntimeProcessRecord,
): RuntimeManagerHeartbeat {
  let stopped = false;
  let heartbeatWork = Promise.resolve();
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => undefined);

  const heartbeat = async (): Promise<void> => {
    if (stopped) return;
    const current = await readProcessRecord(layout);
    if (current === undefined || !sameProcessRecordOwner(current, owner)) {
      throw new Error("The runtime manager lost ownership of its process record.");
    }
    if (stopped) return;
    await writeRuntimeStateJson(layout.processFile, {
      ...current,
      heartbeatAt: new Date().toISOString(),
    });
  };

  const timer = setInterval(() => {
    heartbeatWork = heartbeatWork.then(heartbeat).catch(error => {
      clearInterval(timer);
      rejectFailure(error instanceof Error ? error : new Error(String(error)));
    });
  }, LIFECYCLE_HEARTBEAT_MS);
  timer.unref();

  return {
    failure,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await heartbeatWork;
    },
  };
}

interface StopRequestWatcher {
  requested: Promise<void>;
  stop: () => void;
}

function watchOwnedStopRequest(
  layout: RuntimeLayout,
  owner: RuntimeProcessRecord,
): StopRequestWatcher {
  let watching = true;
  const requested = (async () => {
    while (watching) {
      const current = await readProcessRecord(layout);
      if (current === undefined || !sameProcessRecordOwner(current, owner)) {
        throw new Error("The runtime manager process record changed unexpectedly.");
      }
      const request = await readStopRequest(layout);
      if (request?.instanceId === owner.instanceId) return;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
  })();
  void requested.catch(() => undefined);
  return {
    requested,
    stop: () => {
      watching = false;
    },
  };
}

export async function startTrueForgeRuntime(layout: RuntimeLayout): Promise<void> {
  assertManagedLayout(layout);
  const reservation = await acquireRuntimeLifecycleReservation(layout, "start");
  let runtime: SpawnedRuntime | undefined;
  let ownedRecord: RuntimeProcessRecord | undefined;
  let managerHeartbeat: RuntimeManagerHeartbeat | undefined;
  const launchedChildren: ManagedChildProcess[] = [];
  let reservationReleased = false;
  let evidenceDir = layout.evidenceDir;

  try {
    const processFileExists = await exists(layout.processFile);
    const existingRecord = await readProcessRecord(layout);
    if (runtimeManagerLeaseIsActive(existingRecord)) {
      throw new Error(
        "Cannot start: another ExitRamp-managed local stack is already starting or running.",
      );
    }
    const existingHealth = await localhostRuntimeHealth();
    if (existingHealth.trueforge || existingHealth.exitramp) {
      throw new Error(
        `Cannot start: TrueForge port is ${existingHealth.trueforge ? "occupied" : "stopped"} and ExitRamp port is ${existingHealth.exitramp ? "occupied" : "stopped"}. `
        + (processFileExists
          ? "The saved manager record is stale or unverifiable; no persisted PID was signaled."
          : "Stop the existing localhost services first."),
      );
    }
    if (processFileExists) {
      if (existingRecord === undefined) {
        await rm(layout.processFile, { force: true });
      } else {
        await removeProcessRecordIfOwned(layout, existingRecord);
      }
    }
    await rm(layout.stopRequestFile, { force: true });

    await checkRuntimePrerequisites(layout.repoRoot);
    const installation = await verifyRuntimeInstallation(layout);
    if (!installation.valid) {
      if (installation.detail !== "not installed") {
        throw new Error(
          `The managed TrueForge runtime is not usable: ${installation.detail}. `
          + "Run pnpm trueforge:runtime:install before starting it.",
        );
      }
      await installTrueForgeRuntimeLocked(layout, reservation);
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

    await reservation.assertOwned();
    const trueforge = launchNode(
      "TrueForge",
      trueforgeEntry,
      [],
      join(layout.runtimeDir, "packages", "trueforge"),
      {
        ...process.env,
        HOST: "127.0.0.1",
        NODE_ENV: "production",
        PORT: "8790",
        SQLITE_PATH: layout.sqlitePath,
        STANDALONE: "true",
      },
    );
    launchedChildren.push(trueforge);
    const exitramp = launchNode(
      "ExitRamp MCP",
      tsxEntry,
      [exitrampEntry],
      layout.repoRoot,
      {
        ...process.env,
        EXITRAMP_EVIDENCE_DIR: evidenceDir,
        PORT: "8788",
      },
    );
    launchedChildren.push(exitramp);
    runtime = {
      trueforge,
      exitramp,
    };

    await Promise.all([runtime.trueforge.spawned, runtime.exitramp.spawned]);
    await reservation.assertOwned();
    if (runtime.trueforge.child.pid === undefined || runtime.exitramp.child.pid === undefined) {
      throw new Error("Node did not return process IDs for the local services.");
    }
    const now = new Date().toISOString();
    const record: RuntimeProcessRecord = {
      manager: MANAGER_ID,
      instanceId: randomUUID(),
      managerPid: process.pid,
      trueforgePid: runtime.trueforge.child.pid,
      exitrampPid: runtime.exitramp.child.pid,
      startedAt: now,
      heartbeatAt: now,
      commit: TRUEFORGE_COMMIT,
    };
    await writeRuntimeStateJson(layout.processFile, record);
    ownedRecord = record;
    managerHeartbeat = beginRuntimeManagerHeartbeat(layout, record);
    if (!(await reservation.release())) {
      throw new Error("The start lifecycle reservation was lost before runtime publication.");
    }
    reservationReleased = true;
  } catch (error) {
    let terminationError: unknown;
    if (launchedChildren.length > 0) {
      try {
        await terminateManagedChildren(launchedChildren);
      } catch (caught) {
        terminationError = caught;
      }
    }
    if (terminationError === undefined && managerHeartbeat !== undefined) {
      await managerHeartbeat.stop();
    }
    if (terminationError === undefined && ownedRecord !== undefined) {
      await removeProcessRecordIfOwned(layout, ownedRecord);
      await removeStopRequestIfOwned(layout, ownedRecord.instanceId);
    }
    if (terminationError !== undefined) {
      throw new AggregateError(
        [error, terminationError],
        "Runtime startup failed and one or more owned child processes could not be stopped.",
      );
    }
    throw error;
  } finally {
    if (!reservationReleased) await reservation.release();
  }

  const startedRuntime = runtime;
  const startedRecord = ownedRecord;
  const heartbeat = managerHeartbeat;
  if (startedRuntime === undefined || startedRecord === undefined || heartbeat === undefined) {
    throw new Error("The local runtime did not finish starting.");
  }
  const stopWatcher = watchOwnedStopRequest(layout, startedRecord);
  let stopping = false;
  let stopInFlight: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopInFlight !== undefined) return stopInFlight;
    stopping = true;
    const attempt = (async () => {
      await terminateRuntime(startedRuntime);
      await heartbeat.stop();
      await removeProcessRecordIfOwned(layout, startedRecord);
      await removeStopRequestIfOwned(layout, startedRecord.instanceId);
    })();
    stopInFlight = attempt.catch(error => {
      stopping = false;
      stopInFlight = undefined;
      throw error;
    });
    return stopInFlight;
  };
  const onSignal = (): void => {
    void stop().then(
      () => process.exit(0),
      error => {
        process.exitCode = 1;
        process.stderr.write(
          `Failed to stop the local runtime cleanly: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
      },
    );
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const startupOutcome = await Promise.race([
      Promise.all([
        waitForManagedChildHealth(startedRuntime.trueforge, trueforgeHealthy),
        waitForManagedChildHealth(startedRuntime.exitramp, exitrampHealthy),
      ]).then(() => "healthy" as const),
      stopWatcher.requested.then(() => "stop" as const),
      heartbeat.failure,
    ]);
    if (startupOutcome === "stop") {
      await stop();
      return;
    }
    process.stdout.write("\nExitRamp local stack is ready.\n");
    process.stdout.write(`TrueForge: ${TRUEFORGE_URL}\n`);
    process.stdout.write(`ExitRamp MCP: ${EXITRAMP_URL}/mcp\n`);
    process.stdout.write(`TrueForge data: ${layout.sqlitePath}\n`);
    process.stdout.write(`ExitRamp evidence: ${evidenceDir}\n`);
    process.stdout.write("Press Ctrl+C to stop both processes.\n\n");

    const runtimeOutcome = await Promise.race([
      startedRuntime.trueforge.settled.then(() => "child" as const),
      startedRuntime.exitramp.settled.then(() => "child" as const),
      stopWatcher.requested.then(() => "stop" as const),
      heartbeat.failure,
    ]);
    if (runtimeOutcome === "stop") {
      await stop();
      return;
    }
    const latestRequest = await readStopRequest(layout);
    if (
      !stopping
      && latestRequest?.instanceId !== startedRecord.instanceId
    ) {
      throw new Error("One local service exited; both services have been stopped.");
    }
  } finally {
    stopWatcher.stop();
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
