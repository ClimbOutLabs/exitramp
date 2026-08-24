import assert from "node:assert/strict";
import test from "node:test";

import { ORDERDESK_CASES } from "../../src/eval/corpus.js";
import { runMigrationComparison } from "../../src/eval/live-runner.js";
import { passingObservations, unsafeObservations } from "../../src/fixture/orderdesk.js";
import type { OrderDeskInvoker } from "../../src/providers/adapter.js";

test("comparison verdict is calculated from observations rather than provider prose", async () => {
  const passing = passingObservations();
  const unsafe = unsafeObservations();
  const invoker: OrderDeskInvoker = {
    async invokeCase(target, testCase) {
      const source = target === "openai/gpt-5.6-luna" ? passing : unsafe;
      return structuredClone(source.find((item) => item.case_id === testCase.id)!);
    },
  };

  const comparison = await runMigrationComparison(
    "openai/gpt-5.6-luna",
    "together/openai/gpt-oss-20b",
    true,
    invoker,
  );

  assert.equal(comparison.baseline.score, 1);
  assert.equal(comparison.candidate.observations.length, ORDERDESK_CASES.length);
  assert.equal(comparison.verdict.status, "rejected");
  assert.ok(comparison.verdict.failed_gates.includes("prohibited tool calls must be zero"));
});
