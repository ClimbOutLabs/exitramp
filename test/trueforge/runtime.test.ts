import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
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
  acquireRuntimeLifecycleReservation,
  acquireRuntimeStartReservation,
  assertManagedLayout,
  commandInvocation,
  createRuntimeStateWriter,
  formatRuntimeStatus,
  installTrueForgeRuntime,
  launchManagedProcess,
  removeProcessRecordIfOwned,
  runtimeEvidenceDirectory,
  runtimeLayout,
  runtimeManagerLeaseIsActive,
  runtimeStopWasRequested,
  stopTrueForgeRuntime,
  terminateManagedChildren,
  verifyRuntimeInstallation,
  waitForManagedChildExit,
  waitForManagedChildHealth,
  writeRuntimeStateJson,
} from "../../src/trueforge/runtime.js";

test("portable runtime paths stay inside ExitRamp-owned ignored directories", () => {
  const root = resolve("portable-runtime-test");
  const layout = runtimeLayout(root);

  assert.doesNotThrow(() => assertManagedLayout(layout));
  assert.equal(layout.runtimeDir, join(root, ".trueforge", "runtime"));
  assert.equal(layout.sqlitePath, join(root, ".trueforge", "data", "db.sqlite"));
  assert.equal(layout.processFile, join(root, ".trueforge", "run", "processes.json"));
  assert.equal(layout.stopRequestFile, join(root, ".trueforge", "run", "stop-request.json"));
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
      /lifecycle operation is already in progress/u,
    );
    await new Promise(resolvePromise => setTimeout(resolvePromise, 700));
    await assert.doesNotReject(first.assertOwned());
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
    instanceId: "original-manager-instance",
    managerPid: process.pid,
    trueforgePid: process.pid,
    exitrampPid: process.pid,
    startedAt: "2026-08-30T01:00:00.000Z",
    heartbeatAt: new Date().toISOString(),
    commit: TRUEFORGE_COMMIT as typeof TRUEFORGE_COMMIT,
  };
  try {
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(layout.processFile, `${JSON.stringify(record)}\n`, "utf8");

    assert.equal(await removeProcessRecordIfOwned(layout, {
      managerPid: record.managerPid,
      instanceId: "newer-manager-instance",
    }), false);
    assert.deepEqual(JSON.parse(await readFile(layout.processFile, "utf8")), record);

    assert.equal(await removeProcessRecordIfOwned(layout, record), true);
    await assert.rejects(access(layout.processFile));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manager state writes are serialized when callers overlap", async () => {
  let activeReplacements = 0;
  let maximumActiveReplacements = 0;
  let replacementCount = 0;
  let markFirstReplacementStarted!: () => void;
  const firstReplacementStarted = new Promise<void>(resolvePromise => {
    markFirstReplacementStarted = resolvePromise;
  });
  let releaseFirst!: () => void;
  const firstReplacementCanFinish = new Promise<void>(resolvePromise => {
    releaseFirst = resolvePromise;
  });
  const writer = createRuntimeStateWriter("processes.json", {
    write: async () => undefined,
    replace: async () => {
      replacementCount += 1;
      activeReplacements += 1;
      maximumActiveReplacements = Math.max(maximumActiveReplacements, activeReplacements);
      if (replacementCount === 1) {
        markFirstReplacementStarted();
        await firstReplacementCanFinish;
      }
      activeReplacements -= 1;
    },
    remove: async () => undefined,
    delay: async () => undefined,
    temporaryId: (() => {
      let id = 0;
      return () => `write-${String(++id)}`;
    })(),
  });

  const first = writer.write({ heartbeat: 1 });
  const second = writer.write({ heartbeat: 2 });
  await firstReplacementStarted;
  assert.equal(replacementCount, 1);
  releaseFirst();
  await Promise.all([first, second, writer.flush()]);

  assert.equal(maximumActiveReplacements, 1);
  assert.equal(replacementCount, 2);
});

test("atomic manager state replacement retries transient Windows EPERM", async () => {
  const delays: number[] = [];
  let replacements = 0;
  await writeRuntimeStateJson("processes.json", { heartbeat: 1 }, {
    write: async () => undefined,
    replace: async () => {
      replacements += 1;
      if (replacements < 3) {
        const error = new Error("destination is temporarily open") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
    },
    remove: async () => undefined,
    delay: async milliseconds => {
      delays.push(milliseconds);
    },
    temporaryId: () => "retry-test",
  });

  assert.equal(replacements, 3);
  assert.deepEqual(delays, [10, 25]);
});

test("atomic manager state replacement stops after the bounded retry budget", async () => {
  const delays: number[] = [];
  let replacements = 0;
  const operations = {
    write: async (): Promise<void> => undefined,
    replace: async (): Promise<void> => {
      replacements += 1;
      const error = new Error("destination remains busy") as NodeJS.ErrnoException;
      error.code = "EBUSY";
      throw error;
    },
    remove: async (): Promise<void> => undefined,
    delay: async (milliseconds: number): Promise<void> => {
      delays.push(milliseconds);
    },
    temporaryId: (): string => "exhaustion-test",
  };

  await assert.rejects(
    writeRuntimeStateJson("processes.json", { heartbeat: 1 }, operations),
    /destination remains busy/u,
  );
  assert.equal(replacements, 7);
  assert.deepEqual(delays, [10, 25, 50, 100, 200, 400]);
});

test("atomic manager state replacement does not retry non-transient failures", async () => {
  let replacements = 0;
  let delays = 0;
  await assert.rejects(
    writeRuntimeStateJson("processes.json", { heartbeat: 1 }, {
      write: async () => undefined,
      replace: async () => {
        replacements += 1;
        const error = new Error("invalid destination") as NodeJS.ErrnoException;
        error.code = "EINVAL";
        throw error;
      },
      remove: async () => undefined,
      delay: async () => {
        delays += 1;
      },
      temporaryId: () => "non-transient-test",
    }),
    /invalid destination/u,
  );
  assert.equal(replacements, 1);
  assert.equal(delays, 0);
});

test("manager state retry aborts when process-record ownership changes", async () => {
  let replacements = 0;
  let ownerIsCurrent = true;
  await assert.rejects(
    writeRuntimeStateJson(
      "processes.json",
      { heartbeat: 1 },
      {
        write: async () => undefined,
        replace: async () => {
          replacements += 1;
          const error = new Error("destination is temporarily open") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
        remove: async () => undefined,
        delay: async () => {
          ownerIsCurrent = false;
        },
        temporaryId: () => "owner-change-test",
      },
      async () => {
        if (!ownerIsCurrent) throw new Error("process-record owner changed");
      },
    ),
    /process-record owner changed/u,
  );
  assert.equal(replacements, 1);
});

test("install refuses to touch a runtime with a live managed process record", async () => {
  const root = await mkdtemp(join(tmpdir(), "exitramp-runtime-live-install-"));
  const layout = runtimeLayout(root);
  try {
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(layout.processFile, `${JSON.stringify({
      manager: "exitramp-trueforge-runtime-v1",
      instanceId: "live-install-manager",
      managerPid: process.pid,
      trueforgePid: process.pid,
      exitrampPid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
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
      operation: "start",
      startedAt: new Date().toISOString(),
    })}\n`, "utf8");

    await assert.rejects(
      installTrueForgeRuntime(layout),
      /Another ExitRamp lifecycle operation is already in progress/u,
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

test("concurrent standalone installs share one exclusive lifecycle reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "exitramp-runtime-concurrent-install-"));
  const layout = runtimeLayout(root);
  try {
    const firstOutcome = installTrueForgeRuntime(layout).then(
      () => undefined,
      error => error,
    );
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        await access(layout.startLockFile);
        break;
      } catch {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
      }
    }
    await access(layout.startLockFile);
    await assert.rejects(
      installTrueForgeRuntime(layout),
      /lifecycle operation is already in progress/u,
    );
    assert.ok(await firstOutcome instanceof Error);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop cannot pass a start that has not published its process record", async () => {
  const root = await mkdtemp(join(tmpdir(), "exitramp-runtime-stop-during-start-"));
  const layout = runtimeLayout(root);
  const reservation = await acquireRuntimeLifecycleReservation(layout, "start");
  try {
    await assert.rejects(
      stopTrueForgeRuntime(layout),
      /lifecycle operation is already in progress/u,
    );
  } finally {
    await reservation.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("a live numeric PID without a fresh instance lease is never trusted", () => {
  const now = Date.now();
  const record = {
    manager: "exitramp-trueforge-runtime-v1" as const,
    instanceId: "reused-pid-shaped-record",
    managerPid: process.pid,
    trueforgePid: process.pid,
    exitrampPid: process.pid,
    startedAt: new Date(now - 60_000).toISOString(),
    heartbeatAt: new Date(now - 60_000).toISOString(),
    commit: TRUEFORGE_COMMIT as typeof TRUEFORGE_COMMIT,
  };
  assert.equal(runtimeManagerLeaseIsActive(record, now), false);
  assert.equal(runtimeManagerLeaseIsActive({
    ...record,
    heartbeatAt: new Date(now).toISOString(),
  }, now), true);
});

test("stop discards a legacy PID-only record without signaling its PIDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "exitramp-runtime-legacy-stop-"));
  const layout = runtimeLayout(root);
  try {
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(layout.processFile, `${JSON.stringify({
      manager: "exitramp-trueforge-runtime-v1",
      managerPid: process.pid,
      trueforgePid: process.pid,
      exitrampPid: process.pid,
      startedAt: "2026-08-30T00:00:00.000Z",
      commit: TRUEFORGE_COMMIT,
    })}\n`, "utf8");

    await assert.doesNotReject(stopTrueForgeRuntime(layout));
    await assert.rejects(access(layout.processFile));
    assert.equal(runtimeManagerLeaseIsActive(undefined), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OS spawn errors are captured before health observation without an unhandled event", async () => {
  const root = await mkdtemp(join(tmpdir(), "exitramp-runtime-spawn-error-"));
  try {
    const managed = launchManagedProcess(
      "Impossible process",
      join(root, "executable-that-does-not-exist"),
      [],
      root,
      process.env,
    );
    await assert.rejects(
      waitForManagedChildHealth(managed, async () => false, 2_000),
      /Impossible process failed to spawn/u,
    );
    assert.equal(await waitForManagedChildExit(managed, 2_000), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown timeouts fail and do not claim a managed child exited", async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    pid: 424_242,
    kill: () => true,
  }) as unknown as ChildProcess;
  const managed = {
    name: "Unresponsive owned child",
    child,
    spawned: Promise.resolve(),
    settled: new Promise<void>(() => undefined),
  };

  assert.equal(await waitForManagedChildExit(managed, 5), false);
  await assert.rejects(
    terminateManagedChildren([managed], 5, 5),
    /Could not stop managed process: Unresponsive owned child/u,
  );
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
    instanceId: "intentional-stop-instance",
    managerPid: 101,
    trueforgePid: 102,
    exitrampPid: 103,
    startedAt: "2026-08-30T00:00:00.000Z",
    heartbeatAt: "2026-08-30T00:00:01.000Z",
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
