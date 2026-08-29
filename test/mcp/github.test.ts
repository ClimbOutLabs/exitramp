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
    return Promise.resolve(Response.json({
      truncated: false,
      tree: [
        { path: "package.json", type: "blob", sha: "file-sha", size: 42 },
        { path: "src", type: "tree", sha: "directory-sha" },
      ],
    }));
  }
  return Promise.resolve(new Response(null, { status: 404 }));
}

test("creates an immutable bounded snapshot whose identity covers its file manifest", async () => {
  const original = await snapshotRepository("acme", "orderdesk", "main", {
    fetch: fakeFetch as typeof fetch,
  });
  const changed = await snapshotRepository("acme", "orderdesk", "main", {
    fetch: ((input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/repos/acme/orderdesk/git/trees/tree-sha?recursive=1")) {
        return Promise.resolve(Response.json({
          truncated: false,
          tree: [{ path: "package.json", type: "blob", sha: "changed-file-sha", size: 42 }],
        }));
      }
      return fakeFetch(input);
    }) as typeof fetch,
  });

  assert.equal(original.resolved_sha, "commit-sha");
  assert.equal(original.default_branch, "main");
  assert.equal(original.tree_truncated, false);
  assert.deepEqual(original.files, [{ path: "package.json", sha: "file-sha", size: 42 }]);
  assert.match(original.snapshot_id, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(original.snapshot_id, changed.snapshot_id);
});

test("rejects path-like repository input before making a request", async () => {
  let requests = 0;
  await assert.rejects(
    snapshotRepository("acme", "../private", "main", {
      fetch: (() => {
        requests += 1;
        return Promise.resolve(new Response(null, { status: 500 }));
      }) as typeof fetch,
    }),
    /Invalid GitHub repository/,
  );
  assert.equal(requests, 0);
});

test("bounds and releases GitHub response bodies before and during streaming", async () => {
  let declaredCancelled = false;
  const declaredTooLarge = (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (!url.includes("/git/trees/")) return fakeFetch(input);
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      cancel() {
        declaredCancelled = true;
      },
    }), {
      headers: { "content-length": String(8 * 1024 * 1024 + 1) },
    }));
  };
  await assert.rejects(
    snapshotRepository("acme", "orderdesk", "main", { fetch: declaredTooLarge as typeof fetch }),
    /response exceeds 8388608 byte limit/,
  );
  assert.equal(declaredCancelled, true);

  let nonSuccessCancelled = 0;
  const nonSuccess = (): Promise<Response> => Promise.resolve(new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        nonSuccessCancelled += 1;
      },
    }),
    { status: 403 },
  ));
  await assert.rejects(
    snapshotRepository("acme", "orderdesk", "main", { fetch: nonSuccess as typeof fetch }),
    /GitHub API returned 403/,
  );
  assert.ok(nonSuccessCancelled > 0);

  let streamedCancelled = false;
  const streamedTooLarge = (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (!url.includes("/git/trees/")) return fakeFetch(input);
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      },
      cancel() {
        streamedCancelled = true;
      },
    })));
  };
  await assert.rejects(
    snapshotRepository("acme", "orderdesk", "main", { fetch: streamedTooLarge as typeof fetch }),
    /response exceeds 8388608 byte limit/,
  );
  assert.equal(streamedCancelled, true);
});
