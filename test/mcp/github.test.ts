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

test("snapshot identity covers the bounded file manifest", async () => {
  const changedTreeFetch = (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/repos/acme/orderdesk/git/trees/tree-sha?recursive=1")) {
      return Promise.resolve(
        Response.json({
          truncated: false,
          tree: [{ path: "package.json", type: "blob", sha: "changed-file-sha", size: 42 }],
        }),
      );
    }
    return fakeFetch(input);
  };
  const original = await snapshotRepository("acme", "orderdesk", "main", {
    fetch: fakeFetch as typeof fetch,
  });
  const changed = await snapshotRepository("acme", "orderdesk", "main", {
    fetch: changedTreeFetch as typeof fetch,
  });

  assert.notEqual(original.snapshot_id, changed.snapshot_id);
});

test("rejects path-like repository input before making a request", async () => {
  await assert.rejects(
    snapshotRepository("acme", "../private", "main", { fetch: fakeFetch as typeof fetch }),
    /Invalid GitHub repository/,
  );
});

test("cancels a recursive tree body whose declared response is too large", async () => {
  let cancelled = false;
  const fetcher = (input: string | URL | Request): Promise<Response> => {
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
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      return Promise.resolve(
        new Response(body, {
          headers: { "content-length": String(8 * 1024 * 1024 + 1) },
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };

  await assert.rejects(
    snapshotRepository("acme", "orderdesk", "main", { fetch: fetcher as typeof fetch }),
    /response exceeds 8388608 byte limit/,
  );
  assert.equal(cancelled, true);
});



test("cancels a non-success response body before rejecting", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const fetcher = (): Promise<Response> =>
    Promise.resolve(new Response(body, { status: 403 }));

  await assert.rejects(
    snapshotRepository("acme", "orderdesk", "main", { fetch: fetcher as typeof fetch }),
    /GitHub API returned 403/,
  );
  assert.equal(cancelled, true);
});
test("rejects a recursive tree after streaming beyond the response-byte limit", async () => {
  const fetcher = (input: string | URL | Request): Promise<Response> => {
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
      const oversizedBody = JSON.stringify({
        truncated: false,
        tree: [{ path: "large.bin", type: "blob", sha: "file-sha", size: 9 * 1024 * 1024 }],
      });
      return Promise.resolve(new Response(oversizedBody.padEnd(8 * 1024 * 1024 + 1, "x")));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };

  await assert.rejects(
    snapshotRepository("acme", "orderdesk", "main", { fetch: fetcher as typeof fetch }),
    /response exceeds 8388608 byte limit/,
  );
});
