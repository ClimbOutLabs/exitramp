import { createHash } from "node:crypto";

import { z } from "zod/v4";

import { canonicalJson } from "../domain/canonical.js";

const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
const REF = /^[A-Za-z0-9_./-]+$/;
const DEFAULT_JSON_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;
// GitHub documents recursive tree responses as bounded at roughly 7 MB. Keep
// a little headroom for JSON overhead while still refusing an unbounded body.
const TREE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

interface GitHubRepository {
  default_branch: string;
}

interface GitHubCommit {
  sha: string;
  commit: { tree: { sha: string } };
}

interface GitHubTree {
  truncated: boolean;
  tree: Array<{ path: string; type: string; sha: string; size?: number }>;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the original HTTP or response-bound failure.
  }
}

export interface RepositorySnapshot {
  snapshot_id: string;
  owner: string;
  repository: string;
  requested_ref: string;
  resolved_sha: string;
  default_branch: string;
  tree_truncated: boolean;
  files: Array<{ path: string; sha: string; size: number | null }>;
}

export const RepositorySnapshotSchema = z.object({
  snapshot_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  owner: z.string().min(1),
  repository: z.string().min(1),
  requested_ref: z.string().min(1),
  resolved_sha: z.string().min(1),
  default_branch: z.string().min(1),
  tree_truncated: z.boolean(),
  files: z.array(z.object({
    path: z.string().min(1),
    sha: z.string().min(1),
    size: z.number().int().nonnegative().nullable(),
  }).strict()),
}).strict();

export interface SnapshotOptions {
  fetch?: typeof fetch;
  token?: string;
}

function validatePart(label: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value) || value.includes("..")) {
    throw new Error(`Invalid GitHub ${label}`);
  }
}

async function githubJson<T>(
  fetcher: typeof fetch,
  path: string,
  token?: string,
  maxBytes = DEFAULT_JSON_RESPONSE_MAX_BYTES,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ExitRamp/0.1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetcher(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`GitHub API returned ${response.status} for ${path}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await cancelResponseBody(response);
      throw new Error(`GitHub API response exceeds ${maxBytes} byte limit for ${path}`);
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`GitHub API response exceeds ${maxBytes} byte limit for ${path}`);
    }
    return JSON.parse(text) as T;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`GitHub API response exceeds ${maxBytes} byte limit for ${path}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

export async function snapshotRepository(
  owner: string,
  repository: string,
  ref = "HEAD",
  options: SnapshotOptions = {},
): Promise<RepositorySnapshot> {
  validatePart("owner", owner, REPOSITORY_PART);
  validatePart("repository", repository, REPOSITORY_PART);
  validatePart("ref", ref, REF);

  const fetcher = options.fetch ?? fetch;
  const basePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const [repo, commit] = await Promise.all([
    githubJson<GitHubRepository>(fetcher, basePath, options.token),
    githubJson<GitHubCommit>(fetcher, `${basePath}/commits/${encodeURIComponent(ref)}`, options.token),
  ]);
  const tree = await githubJson<GitHubTree>(
    fetcher,
    `${basePath}/git/trees/${encodeURIComponent(commit.commit.tree.sha)}?recursive=1`,
    options.token,
    TREE_RESPONSE_MAX_BYTES,
  );

  const blobs = tree.tree.filter((entry) => entry.type === "blob");
  const files = blobs
    .slice(0, 5_000)
    .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? null }));
  const snapshot = {
    owner,
    repository,
    requested_ref: ref,
    resolved_sha: commit.sha,
    default_branch: repo.default_branch,
    tree_truncated: tree.truncated || blobs.length > files.length,
    files,
  };
  const digest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");

  return RepositorySnapshotSchema.parse({
    snapshot_id: `sha256:${digest}`,
    ...snapshot,
  });
}
