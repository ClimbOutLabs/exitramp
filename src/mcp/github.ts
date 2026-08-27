import { createHash } from "node:crypto";

import { z } from "zod/v4";

const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
const REF = /^[A-Za-z0-9_./-]+$/;

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
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ExitRamp/0.1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetcher(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} for ${path}`);
  }
  return (await response.json()) as T;
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
  );

  const blobs = tree.tree.filter((entry) => entry.type === "blob");
  const files = blobs
    .slice(0, 5_000)
    .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? null }));
  const digest = createHash("sha256")
    .update(`${owner}/${repository}@${commit.sha}`)
    .digest("hex");

  return RepositorySnapshotSchema.parse({
    snapshot_id: `sha256:${digest}`,
    owner,
    repository,
    requested_ref: ref,
    resolved_sha: commit.sha,
    default_branch: repo.default_branch,
    tree_truncated: tree.truncated || blobs.length > files.length,
    files,
  });
}
