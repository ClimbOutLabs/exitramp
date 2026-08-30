import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const EXITRAMP_MCP_NAME = "exitramp";
export const PROVIDER_CREDENTIAL_HEADERS = {
  openai: "x-exitramp-openai-key",
  together: "x-exitramp-together-key",
} as const;

export type JsonFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface TrueForgeCredentials {
  openaiApiKey: string;
  togetherApiKey: string;
}

export interface ConfigureCredentialsOptions {
  trueforgeUrl?: string;
  fetchImpl?: JsonFetch;
  credentials?: TrueForgeCredentials;
  readSecret?: (prompt: string) => Promise<string>;
}

interface HiddenInput {
  isTTY?: boolean;
  on(event: "data", listener: (chunk: string | Buffer) => void): HiddenInput;
  off(event: "data", listener: (chunk: string | Buffer) => void): HiddenInput;
  resume(): HiddenInput;
  pause(): HiddenInput;
  setRawMode?(enabled: boolean): HiddenInput;
}

interface Output {
  isTTY?: boolean;
  write(chunk: string): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function assertCredential(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} credential was empty.`);
  return trimmed;
}

/** Read a secret without echoing its characters to the terminal. */
export function readHiddenSecret(
  prompt: string,
  input: HiddenInput = process.stdin,
  output: Output = process.stdout,
): Promise<string> {
  if (!input.isTTY || !output.isTTY || input.setRawMode === undefined) {
    throw new Error("Credential setup requires an interactive TTY.");
  }

  output.write(prompt);
  input.setRawMode(true);
  input.resume();

  return new Promise((resolveSecret, reject) => {
    let value = "";

    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
    };

    const onData = (chunk: string | Buffer): void => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("Credential setup cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          output.write("\n");
          resolveSecret(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        if (character >= " " && character !== "\u007f") value += character;
      }
    };

    input.on("data", onData);
  });
}

async function requestJson(
  fetchImpl: JsonFetch,
  url: URL,
  init?: RequestInit,
): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (init?.body !== undefined) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, headers });
  } catch {
    throw new Error(`Unable to reach TrueForge at ${url.origin}.`);
  }
  if (!response.ok) {
    throw new Error(`TrueForge rejected ${init?.method ?? "GET"} ${url.pathname} (${response.status}).`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`TrueForge returned an invalid response for ${url.pathname}.`);
  }
}

function connectorManifest(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.manifest)) {
    throw new Error("TrueForge returned an invalid ExitRamp connector.");
  }
  const manifest = payload.data.manifest;
  if (manifest.name !== EXITRAMP_MCP_NAME) {
    throw new Error("TrueForge returned the wrong MCP connector.");
  }
  return manifest;
}

async function resolveCredentials(
  options: ConfigureCredentialsOptions,
): Promise<TrueForgeCredentials> {
  if (options.credentials !== undefined) return options.credentials;
  const readSecret = options.readSecret ?? ((prompt: string) =>
    readHiddenSecret(prompt));
  return {
    openaiApiKey: await readSecret("OpenAI API key (hidden): "),
    togetherApiKey: await readSecret("Together API key (hidden): "),
  };
}

/** Configure TrueForge to send both provider keys only to the ExitRamp MCP. */
export async function configureTrueForgeCredentials(
  options: ConfigureCredentialsOptions = {},
): Promise<void> {
  const baseUrl = new URL(options.trueforgeUrl ?? "http://127.0.0.1:8790");
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("TRUEFORGE_URL must use http or https.");
  }
  const credentials = await resolveCredentials(options);
  const openaiApiKey = assertCredential(credentials.openaiApiKey, "OpenAI");
  const togetherApiKey = assertCredential(credentials.togetherApiKey, "Together");
  const fetchImpl = options.fetchImpl ?? fetch;

  const existing = await requestJson(
    fetchImpl,
    new URL(`/api/v1/settings/mcp-servers/${EXITRAMP_MCP_NAME}`, baseUrl),
  );
  const manifest = connectorManifest(existing);
  const existingHeaders = isRecord(manifest.auth) && manifest.auth.type === "header"
    ? stringRecord(manifest.auth.headers)
    : {};
  const updatedManifest: Record<string, unknown> = {
    ...manifest,
    auth: {
      type: "header",
      headers: {
        ...existingHeaders,
        [PROVIDER_CREDENTIAL_HEADERS.openai]: openaiApiKey,
        [PROVIDER_CREDENTIAL_HEADERS.together]: togetherApiKey,
      },
    },
  };

  await requestJson(fetchImpl, new URL("/api/v1/settings/mcp-servers", baseUrl), {
    method: "PUT",
    body: JSON.stringify({ manifest: updatedManifest }),
  });
}

async function main(): Promise<void> {
  await configureTrueForgeCredentials({
    ...(process.env.TRUEFORGE_URL === undefined
      ? {}
      : { trueforgeUrl: process.env.TRUEFORGE_URL }),
  });
  process.stdout.write("TrueForge now has both provider credentials for the ExitRamp connector.\n");
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await main();
