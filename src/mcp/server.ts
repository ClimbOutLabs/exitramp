import { createServer } from "node:http";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import { snapshotRepository } from "./github.js";

const PORT = Number.parseInt(process.env.PORT ?? "8788", 10);

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "exitramp", version: "0.1.0" });

  server.registerTool(
    "repo_snapshot",
    {
      title: "Snapshot a GitHub repository",
      description:
        "Resolve a GitHub ref to an immutable commit and return a bounded source-tree manifest.",
      inputSchema: z.object({
        owner: z.string().min(1),
        repository: z.string().min(1),
        ref: z.string().min(1).default("HEAD"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ owner, repository, ref }) => {
      const token = process.env.GITHUB_TOKEN;
      const snapshot = await snapshotRepository(
        owner,
        repository,
        ref,
        token ? { token } : {},
      );
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot) }],
        structuredContent: snapshot,
      };
    },
  );

  return server;
}

const mcpHandler = createMcpHandler(buildMcpServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const httpServer = createServer(async (request, response) => {
  if (!validateHost(request, response) || !validateOrigin(request, response)) return;

  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "exitramp-mcp" }));
    return;
  }
  if (path !== "/mcp") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  // MCP's structural request type is narrower than Node's IncomingMessage when
  // exactOptionalPropertyTypes is enabled, although this adapter targets it.
  await nodeMcpHandler(request as Parameters<typeof nodeMcpHandler>[0], response);
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`ExitRamp MCP listening at http://127.0.0.1:${PORT}/mcp`);
});
