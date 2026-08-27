import { createHash } from "node:crypto";

import { z } from "zod/v4";

import { canonicalJson } from "../domain/canonical.js";

/** The bounded command plan whose execution must be represented by a sandbox trace. */
export const VERIFICATION_COMMAND_PLAN = [
  { id: "typecheck", command: "pnpm typecheck" },
  { id: "test", command: "pnpm test" },
] as const;

export type VerificationCommandId = (typeof VERIFICATION_COMMAND_PLAN)[number]["id"];
export type VerificationCommand = (typeof VERIFICATION_COMMAND_PLAN)[number];

/**
 * The legacy receipt shape is retained for callers of the pure verifier.  New
 * MCP callers must use SandboxVerificationReceipt, which carries the sandbox
 * trace fields needed for structural provenance.
 */
export interface VerificationReceipt {
  command_id: string;
  command: string;
  commit_sha: string;
  exit_code: number | null;
  timed_out: boolean;
  sandbox_id?: string;
  stdout_sha256?: string;
  stderr_sha256?: string;
  duration_ms?: number;
}

const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/;

export const SandboxVerificationReceiptSchema = z.object({
  sandbox_id: z.string().min(1).max(200),
  command_id: z.string().min(1),
  command: z.string().min(1),
  commit_sha: z.string().min(1).max(200),
  exit_code: z.number().int().nonnegative().nullable(),
  timed_out: z.boolean(),
  stdout_sha256: z.string().regex(SHA256),
  stderr_sha256: z.string().regex(SHA256),
  duration_ms: z.number().finite().nonnegative(),
}).strict();

export type SandboxVerificationReceipt = z.infer<typeof SandboxVerificationReceiptSchema>;

export interface VerificationReport {
  status: "verified" | "rejected";
  expected_commit_sha: string;
  command_plan: readonly VerificationCommand[];
  receipts: readonly VerificationReceipt[];
  failed_gates: readonly string[];
  evidence_id: string;
  sandbox_id?: string;
}

function evidenceId(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function sortedReceipts(receipts: readonly VerificationReceipt[]): VerificationReceipt[] {
  return [...receipts].sort((left, right) => {
    const byId = left.command_id.localeCompare(right.command_id);
    return byId !== 0 ? byId : left.command.localeCompare(right.command);
  });
}

function verifyReceiptShape(receipt: SandboxVerificationReceipt, failures: Set<string>): void {
  if (!SHA256.test(receipt.stdout_sha256)) failures.add(`invalid stdout hash: ${receipt.command_id}`);
  if (!SHA256.test(receipt.stderr_sha256)) failures.add(`invalid stderr hash: ${receipt.command_id}`);
  if (!Number.isFinite(receipt.duration_ms) || receipt.duration_ms < 0) {
    failures.add(`invalid duration: ${receipt.command_id}`);
  }
}

/**
 * Validate detailed sandbox receipts against the fixed command plan and a
 * commit already resolved from a persisted repository snapshot.  This is
 * structural provenance only: the native TrueForge trace remains the source
 * of execution evidence; this function does not claim cryptographic
 * attestation or create a sandbox itself.
 */
export function verifySandboxReceipts(
  expectedCommitSha: string,
  receipts: readonly SandboxVerificationReceipt[],
): VerificationReport {
  const failures = new Set<string>();
  const planById = new Map<string, VerificationCommand>(
    VERIFICATION_COMMAND_PLAN.map((command) => [command.id, command]),
  );
  const seen = new Set<string>();
  const sandboxIds = new Set<string>();

  if (expectedCommitSha.trim().length === 0) failures.add("expected commit SHA is required");

  for (const receipt of receipts) {
    sandboxIds.add(receipt.sandbox_id);
    verifyReceiptShape(receipt, failures);
    const planned = planById.get(receipt.command_id);
    if (!planned) {
      failures.add(`unknown receipt: ${receipt.command_id}`);
      continue;
    }
    if (seen.has(receipt.command_id)) failures.add(`duplicate receipt: ${receipt.command_id}`);
    seen.add(receipt.command_id);
    if (receipt.command !== planned.command) failures.add(`command mismatch: ${receipt.command_id}`);
    if (receipt.commit_sha !== expectedCommitSha) failures.add(`commit mismatch: ${receipt.command_id}`);
    if (receipt.timed_out) failures.add(`command timed out: ${receipt.command_id}`);
    if (receipt.exit_code === null) {
      failures.add(`null exit code: ${receipt.command_id}`);
    } else if (receipt.exit_code !== 0) {
      failures.add(`nonzero exit code: ${receipt.command_id}`);
    }
  }
  if (sandboxIds.size > 1) failures.add("sandbox IDs do not match");
  for (const command of VERIFICATION_COMMAND_PLAN) {
    if (!seen.has(command.id)) failures.add(`missing receipt: ${command.id}`);
  }

  const failedGates = [...failures].sort((left, right) => left.localeCompare(right));
  const normalizedReceipts = sortedReceipts(receipts);
  const evidencePayload = {
    expected_commit_sha: expectedCommitSha,
    command_plan: VERIFICATION_COMMAND_PLAN,
    receipts: normalizedReceipts,
    failed_gates: failedGates,
  };
  return {
    status: failedGates.length === 0 ? "verified" : "rejected",
    expected_commit_sha: expectedCommitSha,
    command_plan: VERIFICATION_COMMAND_PLAN,
    receipts: normalizedReceipts,
    failed_gates: failedGates,
    evidence_id: evidenceId(evidencePayload),
    ...(receipts.length > 0 ? { sandbox_id: receipts[0]!.sandbox_id } : {}),
  };
}

/**
 * Validate receipts against the immutable command plan.
 *
 * The function is intentionally receipt-only: it trusts no caller-provided
 * "tests passed" flag and has no process, filesystem, or Daytona access. A
 * report is verified only when every planned command has exactly one receipt,
 * both the command and commit match, and the command completed successfully
 * without timing out.
 */
export function verifyCommandReceipts(
  expectedCommitSha: string,
  receipts: readonly VerificationReceipt[],
): VerificationReport {
  const failures = new Set<string>();
  const planById = new Map<string, VerificationCommand>(
    VERIFICATION_COMMAND_PLAN.map((command) => [command.id, command]),
  );
  const seen = new Set<string>();

  if (expectedCommitSha.trim().length === 0) {
    failures.add("expected commit SHA is required");
  }

  for (const receipt of receipts) {
    const planned = planById.get(receipt.command_id);
    if (!planned) {
      failures.add(`unknown receipt: ${receipt.command_id}`);
      continue;
    }

    if (seen.has(receipt.command_id)) {
      failures.add(`duplicate receipt: ${receipt.command_id}`);
    }
    seen.add(receipt.command_id);

    if (receipt.command !== planned.command) {
      failures.add(`command mismatch: ${receipt.command_id}`);
    }
    if (receipt.commit_sha !== expectedCommitSha) {
      failures.add(`commit mismatch: ${receipt.command_id}`);
    }
    if (receipt.timed_out) {
      failures.add(`command timed out: ${receipt.command_id}`);
    }
    if (receipt.exit_code === null) {
      failures.add(`null exit code: ${receipt.command_id}`);
    } else if (!Number.isInteger(receipt.exit_code) || receipt.exit_code < 0) {
      failures.add(`invalid exit code: ${receipt.command_id}`);
    } else if (receipt.exit_code !== 0) {
      failures.add(`nonzero exit code: ${receipt.command_id}`);
    }
  }

  for (const command of VERIFICATION_COMMAND_PLAN) {
    if (!seen.has(command.id)) failures.add(`missing receipt: ${command.id}`);
  }

  const failedGates = [...failures].sort((left, right) => left.localeCompare(right));
  const normalizedReceipts = sortedReceipts(receipts);
  const evidencePayload = {
    expected_commit_sha: expectedCommitSha,
    command_plan: VERIFICATION_COMMAND_PLAN,
    receipts: normalizedReceipts,
    failed_gates: failedGates,
  };

  return {
    status: failedGates.length === 0 ? "verified" : "rejected",
    expected_commit_sha: expectedCommitSha,
    command_plan: VERIFICATION_COMMAND_PLAN,
    receipts: normalizedReceipts,
    failed_gates: failedGates,
    evidence_id: evidenceId(evidencePayload),
  };
}
