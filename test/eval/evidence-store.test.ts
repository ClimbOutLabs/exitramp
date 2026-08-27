import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson } from "../../src/domain/canonical.js";
import {
  defaultEvidenceDirectory,
  evidenceIdFor,
  EVIDENCE_SCHEMA_VERSION,
  EvidenceIntegrityError,
  EvidenceNotFoundError,
  EvidenceStore,
} from "../../src/eval/evidence-store.js";

test("uses the project evidence directory by default", () => {
  const configured = process.env.EXITRAMP_EVIDENCE_DIR;
  if (configured) return;
  assert.match(defaultEvidenceDirectory().replace(/\\/g, "/"), /\/\.exitramp\/evidence$/);
});

test("canonicalJson rejects values that JSON.stringify would silently coerce", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const unsupported: unknown[] = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    () => undefined,
    Symbol("unsupported"),
    1n,
    cyclic,
    [undefined],
    new Date("2026-01-01T00:00:00.000Z"),
  ];

  for (const value of unsupported) assert.throws(() => canonicalJson(value), TypeError);
  const withSymbol = { value: "ok", [Symbol("hidden")]: "secret" };
  assert.throws(() => canonicalJson(withSymbol), TypeError);
  const sparse: string[] = [];
  sparse.length = 1;
  assert.throws(() => canonicalJson(sparse), TypeError);
});

test("EvidenceStore writes and reads a content-addressed immutable envelope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-evidence-"));
  try {
    const store = new EvidenceStore({
      directory,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    });
    const written = await store.write({
      artifact_type: "scenario-plan",
      created_at: "2026-08-25T12:00:00.000Z",
      parent_ids: ["sha256:" + "a".repeat(64)],
      payload: { cases: ["delivery-delay", "refund-review"] },
    });

    assert.match(written.evidence_id, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(await store.read(written.evidence_id), written);
    assert.equal(await store.verify(written.evidence_id), true);
    assert.equal(await readFile(store.pathFor(written.evidence_id), "utf8"), canonicalJson(written));

    // A second create-only write returns the verified existing artifact and
    // does not rewrite its bytes.
    const duplicate = await store.write({
      artifact_type: "scenario-plan",
      created_at: "2026-08-25T12:00:00.000Z",
      parent_ids: ["sha256:" + "a".repeat(64)],
      payload: { cases: ["delivery-delay", "refund-review"] },
    });
    assert.deepEqual(duplicate, written);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("EvidenceStore detects byte and content tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-evidence-"));
  try {
    const store = new EvidenceStore(directory);
    const written = await store.put({
      artifact_type: "evaluation",
      created_at: "2026-08-25T12:00:00.000Z",
      payload: { score: 1 },
    });
    const filePath = store.pathFor(written.evidence_id);

    await writeFile(filePath, `${canonicalJson(written)}\n`, "utf8");
    await assert.rejects(store.read(written.evidence_id), EvidenceIntegrityError);

    await writeFile(filePath, JSON.stringify({ ...written, payload: { score: 0 } }), "utf8");
    await assert.rejects(store.read(written.evidence_id), EvidenceIntegrityError);
    await assert.rejects(store.read("sha256:" + "f".repeat(64)), EvidenceNotFoundError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("EvidenceStore publishes concurrent writes atomically without replacing the artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-evidence-"));
  try {
    const store = new EvidenceStore(directory);
    const input = {
      artifact_type: "large-evaluation",
      created_at: "2026-08-25T12:00:00.000Z",
      payload: { details: "x".repeat(2_000_000) },
    };

    const writes = await Promise.all(Array.from({ length: 16 }, () => store.write(input)));
    for (const result of writes) assert.deepEqual(result, writes[0]);
    assert.deepEqual(await store.read(writes[0]!.evidence_id), writes[0]);

    const files = await readdir(directory);
    assert.deepEqual(files, [`${writes[0]!.evidence_id.slice("sha256:".length)}.json`]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("EvidenceStore never exposes a permanent artifact before atomic publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-evidence-"));
  let releasePublish!: () => void;
  let reachedPublish!: () => void;
  const publishReached = new Promise<void>((resolve) => { reachedPublish = resolve; });
  const publicationReleased = new Promise<void>((resolve) => { releasePublish = resolve; });
  try {
    const input = {
      artifact_type: "evaluation",
      created_at: "2026-08-25T12:00:00.000Z",
      payload: { details: "complete before publication" },
    };
    const evidenceId = evidenceIdFor({
      schema_version: EVIDENCE_SCHEMA_VERSION,
      artifact_type: input.artifact_type,
      created_at: input.created_at,
      parent_ids: [],
      payload: input.payload,
    });
    const store = new EvidenceStore({
      directory,
      before_publish: async () => {
        reachedPublish();
        await publicationReleased;
      },
    });
    const writing = store.write(input);
    await publishReached;

    // This read runs concurrently with the paused writer. The permanent name
    // must remain absent until the complete temp file is atomically linked.
    await assert.rejects(store.read(evidenceId), EvidenceNotFoundError);
    const filesBeforePublication = await readdir(directory);
    assert.equal(filesBeforePublication.length, 1);
    assert.match(
      filesBeforePublication[0]!,
      new RegExp(`^\\.${evidenceId.slice("sha256:".length)}\\.json\\.\\d+\\..+\\.tmp$`),
    );

    releasePublish();
    const published = await writing;
    assert.deepEqual(await store.read(evidenceId), published);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("EvidenceStore leaves no artifact when serialization fails before publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-evidence-"));
  try {
    const store = new EvidenceStore(directory);
    await assert.rejects(
      store.write({
        artifact_type: "invalid-evaluation",
        payload: { unsupported: undefined },
      }),
      TypeError,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("EvidenceStore keeps a successful publication successful when cleanup fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-evidence-"));
  const cleanupError = Object.assign(new Error("temporary cleanup failed"), { code: "EACCES" });
  const cleanupDiagnostics: unknown[] = [];
  try {
    const store = new EvidenceStore({
      directory,
      unlink_temporary: async () => {
        throw cleanupError;
      },
      on_cleanup_error: (diagnostic) => {
        cleanupDiagnostics.push(diagnostic);
      },
    });

    const written = await store.write({
      artifact_type: "evaluation",
      created_at: "2026-08-25T12:00:00.000Z",
      payload: { score: 1 },
    });

    assert.deepEqual(await store.read(written.evidence_id), written);
    assert.deepEqual(cleanupDiagnostics, [{ code: "EACCES", publication_committed: true }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("EvidenceStore preserves the primary write error when cleanup also fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "exitramp-evidence-"));
  const primaryError = new Error("publication failed");
  const cleanupError = Object.assign(new Error("temporary cleanup failed"), { code: "EACCES" });
  const cleanupDiagnostics: unknown[] = [];
  try {
    const store = new EvidenceStore({
      directory,
      before_publish: () => {
        throw primaryError;
      },
      unlink_temporary: async () => {
        throw cleanupError;
      },
      on_cleanup_error: (diagnostic) => {
        cleanupDiagnostics.push(diagnostic);
      },
    });

    await assert.rejects(
      store.write({
        artifact_type: "evaluation",
        created_at: "2026-08-25T12:00:00.000Z",
        payload: { score: 1 },
      }),
      (error: unknown) => error === primaryError,
    );
    assert.deepEqual(cleanupDiagnostics, [{ code: "EACCES", publication_committed: false }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
