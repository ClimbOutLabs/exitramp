import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson } from "../../src/domain/canonical.js";
import {
  defaultEvidenceDirectory,
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
