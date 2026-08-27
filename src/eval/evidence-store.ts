import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson } from "../domain/canonical.js";

export const EVIDENCE_SCHEMA_VERSION = 1 as const;

export interface EvidenceEnvelope {
  schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  evidence_id: string;
  artifact_type: string;
  created_at: string;
  parent_ids: string[];
  payload: unknown;
}

export interface EvidenceWriteInput {
  artifact_type: string;
  payload: unknown;
  parent_ids?: readonly string[];
  created_at?: string;
}

export interface EvidenceStoreOptions {
  directory?: string;
  now?: () => Date;
  /** Test seam for pausing between complete temp-file write and publication. */
  before_publish?: () => void | Promise<void>;
}

export class EvidenceNotFoundError extends Error {
  constructor(public readonly evidence_id: string) {
    super(`Evidence artifact not found: ${evidence_id}`);
    this.name = "EvidenceNotFoundError";
  }
}

export class EvidenceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceIntegrityError";
  }
}

export class EvidenceAtomicPublicationUnsupportedError extends Error {
  readonly error_code = "EVIDENCE_ATOMIC_PUBLICATION_UNSUPPORTED" as const;

  constructor(
    public readonly directory: string,
    public readonly filesystem_error_code: string,
  ) {
    super(
      `EvidenceStore cannot atomically publish evidence in ${directory}: ` +
      `the filesystem does not support no-replace hard-link publication ` +
      `(${filesystem_error_code}). Configure EXITRAMP_EVIDENCE_DIR on a local ` +
      "hard-link-capable filesystem; no non-atomic fallback is provided.",
    );
    this.name = "EvidenceAtomicPublicationUnsupportedError";
  }
}

function atomicPublicationUnsupported(error: unknown): error is NodeJS.ErrnoException {
  return ["EPERM", "EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EINVAL"].includes(
    (error as NodeJS.ErrnoException).code ?? "",
  );
}

function evidenceDirectory(directory?: string): string {
  const configured = directory ?? process.env.EXITRAMP_EVIDENCE_DIR;
  return resolve(configured && configured.length > 0 ? configured : ".exitramp/evidence");
}

function assertEvidenceId(evidenceId: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(evidenceId)) {
    throw new EvidenceIntegrityError(`Invalid evidence identifier: ${evidenceId}`);
  }
}

function unsignedEnvelope(envelope: EvidenceEnvelope): Record<string, unknown> {
  return {
    schema_version: envelope.schema_version,
    artifact_type: envelope.artifact_type,
    created_at: envelope.created_at,
    parent_ids: envelope.parent_ids,
    payload: envelope.payload,
  };
}

export function evidenceIdFor(value: Omit<EvidenceEnvelope, "evidence_id">): string {
  const digest = createHash("sha256").update(canonicalJson(value)).digest("hex");
  return `sha256:${digest}`;
}

function validateWriteInput(input: EvidenceWriteInput): {
  artifact_type: string;
  parent_ids: string[];
  created_at: string;
} {
  if (!input || typeof input !== "object") {
    throw new TypeError("Evidence write input must be an object");
  }
  if (typeof input.artifact_type !== "string" || input.artifact_type.length === 0) {
    throw new TypeError("Evidence artifact_type must be a non-empty string");
  }
  const parentIds = input.parent_ids === undefined ? [] : [...input.parent_ids];
  if (parentIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new TypeError("Evidence parent_ids must contain non-empty strings");
  }
  const createdAt = input.created_at ?? new Date().toISOString();
  if (typeof createdAt !== "string" || createdAt.length === 0) {
    throw new TypeError("Evidence created_at must be a non-empty string");
  }
  return { artifact_type: input.artifact_type, parent_ids: parentIds, created_at: createdAt };
}

function validateEnvelope(value: unknown): EvidenceEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EvidenceIntegrityError("Evidence envelope is not an object");
  }
  const envelope = value as Record<string, unknown>;
  const expectedKeys = [
    "artifact_type",
    "created_at",
    "evidence_id",
    "parent_ids",
    "payload",
    "schema_version",
  ].sort();
  const actualKeys = Object.keys(envelope).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new EvidenceIntegrityError("Evidence envelope has an invalid shape");
  }
  if (envelope.schema_version !== EVIDENCE_SCHEMA_VERSION) {
    throw new EvidenceIntegrityError("Unsupported evidence schema version");
  }
  if (typeof envelope.evidence_id !== "string") {
    throw new EvidenceIntegrityError("Evidence ID is missing");
  }
  assertEvidenceId(envelope.evidence_id);
  if (typeof envelope.artifact_type !== "string" || envelope.artifact_type.length === 0) {
    throw new EvidenceIntegrityError("Evidence artifact_type is invalid");
  }
  if (typeof envelope.created_at !== "string" || envelope.created_at.length === 0) {
    throw new EvidenceIntegrityError("Evidence created_at is invalid");
  }
  if (
    !Array.isArray(envelope.parent_ids) ||
    envelope.parent_ids.some((id) => typeof id !== "string" || id.length === 0)
  ) {
    throw new EvidenceIntegrityError("Evidence parent_ids are invalid");
  }
  const typed: EvidenceEnvelope = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    evidence_id: envelope.evidence_id,
    artifact_type: envelope.artifact_type,
    created_at: envelope.created_at,
    parent_ids: [...envelope.parent_ids],
    payload: envelope.payload,
  };
  if (
    evidenceIdFor(unsignedEnvelope(typed) as Omit<EvidenceEnvelope, "evidence_id">) !==
    typed.evidence_id
  ) {
    throw new EvidenceIntegrityError(`Evidence content hash mismatch: ${typed.evidence_id}`);
  }
  return typed;
}

export class EvidenceStore {
  private readonly directoryPath: string;
  private readonly clock: () => Date;
  private readonly beforePublish: (() => void | Promise<void>) | undefined;

  constructor(options?: EvidenceStoreOptions | string) {
    const normalized = typeof options === "string" ? { directory: options } : options;
    this.directoryPath = evidenceDirectory(normalized?.directory);
    this.clock = normalized?.now ?? (() => new Date());
    this.beforePublish = normalized?.before_publish;
  }

  get directory(): string {
    return this.directoryPath;
  }

  pathFor(evidenceId: string): string {
    assertEvidenceId(evidenceId);
    return join(this.directoryPath, `${evidenceId.slice("sha256:".length)}.json`);
  }

  async write(input: EvidenceWriteInput): Promise<EvidenceEnvelope> {
    const createdAt = input.created_at ?? this.clock().toISOString();
    const normalized = validateWriteInput({ ...input, created_at: createdAt });
    const envelopeWithoutId = {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      artifact_type: normalized.artifact_type,
      created_at: normalized.created_at,
      parent_ids: normalized.parent_ids,
      payload: input.payload,
    } as const;
    // canonicalJson is intentionally called before opening the file so an
    // unsupported payload can never result in a partial evidence artifact.
    const evidenceId = evidenceIdFor(envelopeWithoutId);
    const envelope: EvidenceEnvelope = { ...envelopeWithoutId, evidence_id: evidenceId };
    const bytes = canonicalJson(envelope);
    const filePath = this.pathFor(evidenceId);
    await mkdir(dirname(filePath), { recursive: true });
    // Keep the temporary file beside its final path so publication can use an
    // atomic same-filesystem hard-link. Unlike rename, link never replaces an
    // existing destination, which preserves immutable evidence under races.
    const temporaryPath = join(
      dirname(filePath),
      `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let temporaryCreated = false;
    try {
      const handle = await open(temporaryPath, "wx");
      temporaryCreated = true;
      try {
        await handle.writeFile(bytes, "utf8");
      } finally {
        await handle.close();
      }
      await this.beforePublish?.();
      try {
        await link(temporaryPath, filePath);
      } catch (error) {
        if (atomicPublicationUnsupported(error)) {
          throw new EvidenceAtomicPublicationUnsupportedError(
            this.directoryPath,
            error.code!,
          );
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.read(evidenceId);
        if (canonicalJson(existing) !== bytes) {
          throw new EvidenceIntegrityError(`Existing evidence artifact differs: ${evidenceId}`);
        }
        return existing;
      }
      return envelope;
    } finally {
      // A successful link leaves the temporary name as a second hard link;
      // failed writes must not leave either a visible partial artifact or a
      // stale temporary file behind.
      if (temporaryCreated) {
        await unlink(temporaryPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    }
  }

  async put(input: EvidenceWriteInput): Promise<EvidenceEnvelope> {
    return this.write(input);
  }

  async read(evidenceId: string): Promise<EvidenceEnvelope> {
    assertEvidenceId(evidenceId);
    const filePath = this.pathFor(evidenceId);
    let bytes: string;
    try {
      bytes = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new EvidenceNotFoundError(evidenceId);
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes) as unknown;
    } catch {
      throw new EvidenceIntegrityError(`Evidence artifact is not valid JSON: ${evidenceId}`);
    }
    const envelope = validateEnvelope(parsed);
    if (canonicalJson(envelope) !== bytes) {
      throw new EvidenceIntegrityError(`Evidence bytes were tampered with: ${evidenceId}`);
    }
    return envelope;
  }

  async get(evidenceId: string): Promise<EvidenceEnvelope> {
    return this.read(evidenceId);
  }

  async verify(evidenceId: string): Promise<boolean> {
    await this.read(evidenceId);
    return true;
  }
}

export function defaultEvidenceDirectory(): string {
  return evidenceDirectory();
}
