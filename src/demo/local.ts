import { ORDERDESK_CASES } from "../eval/corpus.js";
import { evaluateMigration } from "../eval/policy.js";
import { passingObservations, unsafeObservations } from "../fixture/orderdesk.js";

const common = {
  baseline_score: 0.94,
  repository_tests_passed: true,
  adapter_tests_passed: true,
  cases: ORDERDESK_CASES,
  evaluated_at: "2026-08-24T12:00:00.000Z",
};

const rejected = evaluateMigration({
  ...common,
  candidate: "unsafe-candidate",
  observations: unsafeObservations(),
});
const eligible = evaluateMigration({
  ...common,
  candidate: "eligible-candidate",
  observations: passingObservations(),
});

console.log(JSON.stringify({ rejected, eligible }, null, 2));
