import assert from "node:assert/strict";
import test from "node:test";

import { snapshotRepository } from "../../src/mcp/github.js";

function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url.endsWith("/repos/acme/orderdesk")) {
    return Promise.resolve(Response.json({ default_branch: "main" }));
  }
  if (url.endsWith("/repos/acme/orderdesk/commits/main")) {
    return Promise.resolve(
      Response.json({ sha: "commit-sha", commit: { tree: { sha: "tree-sha" } } }),
    );
  }
  if (url.endsWith("/repos/acme/orderdesk/git/trees/tree-sha?recursive=1")) {
    return Promise.resolve(
      Response.json({
        truncated: false,
        tree: [
          { path: "package.json", type: "blob", sha: "file-sha", size: 42 },
          { path: "src", type: "tree", sha: "directory-sha" },
        ],
      }),
    );
  }
  return Promise.resolve(new Response(null, { status: 404 }));
}

test("creates an immutable, bounded repository snapshot", async () => {
  const snapshot = await snapshotRepository("acme", "orderdesk", "main", {
    fetch: fakeFetch as typeof fetch,
  });

  assert.equal(snapshot.resolved_sha, "commit-sha");
  assert.equal(snapshot.default_branch, "main");
  assert.equal(snapshot.tree_truncated, false);
  assert.deepEqual(snapshot.files, [{ path: "package.json", sha: "file-sha", size: 42 }]);
  assert.match(snapshot.snapshot_id, /^sha256:[a-f0-9]{64}$/);
});

test("rejects path-like repository input before making a request", async () => {
  await assert.rejects(
    snapshotRepository("acme", "../private", "main", { fetch: fakeFetch as typeof fetch }),
    /Invalid GitHub repository/,
  );
});
