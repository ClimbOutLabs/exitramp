import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { repositoryRoot } from "../../scripts/trueforge-runtime.js";
import {
  EXITRAMP_URL,
  TRUEFORGE_COMMIT,
  TRUEFORGE_TAG,
  TRUEFORGE_URL,
  acquireRuntimeStartReservation,
  assertManagedLayout,
  commandInvocation,
  formatRuntimeStatus,
  installTrueForgeRuntime,
  removeProcessRecordIfOwned,
  runtimeEvidenceDirectory,
  runtimeLayout,
  runtimeStopWasRequested,
  stopTrueForgeRuntime,
  verifyRuntimeInstallation,
} from "../../src/trueforge/runtime.js";

test("portable runtime paths stay inside ExitRamp-owned ignored directories", () => {
  const root = resolve("portable-runtime-test");
  const layout = runtimeLayout(root);

  assert.doesNotThrow(() => assertManagedLayout(layout));
  assert.equal(layout.runtimeDir, join(root, ".trueforge", "runtime"));
  assert.equal(layout.sqlitePath, join(root, ".trueforge", "data", "db.sqlite"));
  assert.equal(layout.processFile, join(root, ".trueforge", "run", "processes.json"));
  assert.equal(layout.startLockFile, join(root, ".trueforge", "run", "start.lock"));
  assert.equal(layout.evidenceDir, join(root, ".exitramp", "evidence"));
  assert.equal(
    layout.patchPath,
    join(root, "integrations", "trueforge", "trueforge-0.1.3-exitramp.patch"),
  );
});

test("managed launcher honors a caller-configured evidence directory", () => {
  const root = resolve("portable-runtime-evidence");
  const layout = runtimeLayout(root);

  assert.equal(runtimeEvidenceDirectory(layout, undefined), layout.evidenceDir);
  assert.equal(runtimeEvidenceDirectory(layout, ""), layout.evidenceDir);
  assert.equal(
    runtimeEvidenceDirectory(layout, join("recordings", "nightly")),
    join(root, "recordings", "nightly"),
  );
  const absolute = resolve("portable-runtime-evidence-absolute");
  assert.equal(runtimeEvidenceDirectory(layout, absolute), absolute);
});

test("start reservations are exclusive and release only their own lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "exitramp-runtime-reservation-"));
  const layout = runtimeLayout(root);
  try {
    const first = await acquireRuntimeStartReservation(layout);
    await assert.rejects(
      acquireRuntimeStartReservation(layout),
      /start is already in progress/u,
    );
    assert.equal(await first.release(), true);

    const second = await acquireRuntimeStartReservation(layout);
    assert.equal(await second.release(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process cleanup cannot remove a newer manager's record", async () => {
  const root = await mkdtemp(join(tmpdir(), "exitramp-runtime-owner-"));
  const layout = runtimeLayout(root);
  const record = {
    manager: "exitramp-trueforge-runtime-v1" as const,
    managerPid: process.pid,
    trueforgePid: process.pid,
    exitrampPid: process.pid,
    startedAt: "2026-08-30T01:00:00.000Z",
    commit: TRUEFORGE_COMMIT,
  };
  try {
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(layout.processFile, `${JSON.stringify(record)}\n`, "utf8");

    assert.equal(await removeProcessRecordIfOwned(layout, {
      managerPid: record.managerPid,
      startedAt: "2026-08-30T00:00:00.000Z",
    }), false);
    assert.deepEqual(JSON.parse(await readFile(layout.processFile, "utf8")), record);

    assert.equal(await removeProcessRecordIfOwned(layout, record), true);
    await assert.rejects(access(layout.processFile));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install refuses to touch a runtime with a live managed process record", async () => {
  const root = await mkdtemp(join(tmpdir(), "exitramp-runtime-live-install-"));
  const layout = runtimeLayout(root);
  try {
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(layout.processFile, `${JSON.stringify({
      manager: "exitramp-trueforge-runtime-v1",
      managerPid: process.pid,
      trueforgePid: process.pid,
      exitrampPid: process.pid,
      startedAt: new Date().toISOString(),
      commit: TRUEFORGE_COMMIT,
    })}\n`, "utf8");

    await assert.rejects(
      installTrueForgeRuntime(layout),
      /Cannot install or replace TrueForge while the ExitRamp-managed local stack is running/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install refuses while another process owns the start reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "exitramp-runtime-install-reservation-"));
  const layout = runtimeLayout(root);
  const otherManager = spawn(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)"],
    { stdio: "ignore", windowsHide: true },
  );
  assert.notEqual(otherManager.pid, undefined);
  try {
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(layout.startLockFile, `${JSON.stringify({
      manager: "exitramp-trueforge-runtime-v1",
      managerPid: otherManager.pid,
      nonce: "other-manager-reservation",
      startedAt: new Date().toISOString(),
    })}\n`, "utf8");

    await assert.rejects(
      installTrueForgeRuntime(layout),
      /Cannot install while another local-stack start is in progress/u,
    );
  } finally {
    otherManager.kill("SIGTERM");
    await Promise.race([
      once(otherManager, "exit"),
      new Promise(resolvePromise => setTimeout(resolvePromise, 2_000)),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

test("portable launcher resolves the repository from its own location, not cwd", () => {
  const fakeRoot = resolve("portable-runtime-location");
  const scriptUrl = pathToFileURL(join(fakeRoot, "scripts", "trueforge-runtime.ts")).href;
  assert.equal(repositoryRoot(scriptUrl), fakeRoot);
});

test("Windows pnpm commands use cmd while git remains shell-free", () => {
  assert.deepEqual(
    commandInvocation("pnpm.cmd", ["--version"], "win32", "cmd.exe"),
    {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd", "--version"],
    },
  );
  assert.deepEqual(commandInvocation("git", ["--version"], "win32", "cmd.exe"), {
    command: "git",
    args: ["--version"],
  });
  assert.deepEqual(commandInvocation("pnpm", ["--version"], "darwin"), {
    command: "pnpm",
    args: ["--version"],
  });
});

test("an absent managed runtime is not mistaken for stock TrueForge", async () => {
  const root = await mkdtemp(join(tmpdir(), "exitramp-runtime-"));
  try {
    const installation = await verifyRuntimeInstallation(runtimeLayout(root));
    assert.deepEqual(installation, { valid: false, detail: "not installed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop is idempotent when no managed processes are recorded", async () => {
  const root = await mkdtemp(join(tmpdir(), "exitramp-runtime-stop-"));
  try {
    await assert.doesNotReject(stopTrueForgeRuntime(runtimeLayout(root)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("foreground launcher recognizes an intentional external stop", () => {
  assert.equal(runtimeStopWasRequested({
    manager: "exitramp-trueforge-runtime-v1",
    managerPid: 101,
    trueforgePid: 102,
    exitrampPid: 103,
    startedAt: "2026-08-30T00:00:00.000Z",
    commit: TRUEFORGE_COMMIT,
    stopRequested: true,
  }), true);
  assert.equal(runtimeStopWasRequested(undefined), false);
});

test("status is concise and names pinned runtime and persistent paths", () => {
  const layout = runtimeLayout(resolve("portable-runtime-status"));
  const formatted = formatRuntimeStatus({
    installed: true,
    installDetail: `patched TrueForge ${TRUEFORGE_TAG} at ${TRUEFORGE_COMMIT}`,
    trueforge: "running",
    exitramp: "running",
  }, layout);

  assert.match(formatted, new RegExp(`TrueForge ${TRUEFORGE_URL}`));
  assert.match(formatted, new RegExp(`ExitRamp ${EXITRAMP_URL}`));
  assert.match(formatted, /Persistent TrueForge data:/);
  assert.match(formatted, /Persistent ExitRamp evidence:/);
});
