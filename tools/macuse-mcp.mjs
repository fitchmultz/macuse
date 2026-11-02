#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MacuseSession } from "../lib/macuse-session.mjs";
import { tools } from "../lib/tools.mjs";
import { VERSION } from "./macuse-utils.mjs";

const session = new MacuseSession({ cwd: process.env.MACUSE_CWD ?? process.cwd() });
// The low-level Server is deliberate here: this wrapper passes raw request
// schemas and per-call _meta details that the high-level McpServer API does not
// expose. The SDK deprecation notice itself reserves Server for this use.
// oxlint-disable-next-line typescript/no-deprecated
const server = new Server({ name: "macuse", version: VERSION }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request, { signal }) => {
  try {
    const { content, isError, details } = await session.callTool(
      request.params.name,
      request.params.arguments,
      { signal },
    );
    return { content, isError, _meta: details };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `macuse failed: ${
            error instanceof Error ? error.message : String(error)
          }. Inspect application state; do not automatically replay an action.`,
        },
      ],
      isError: true,
      _meta: { macuse: { outcome: "unknown" } },
    };
  }
});
// Protocol exposes onclose as a plain callback property, not an EventTarget,
// so addEventListener is not available here.
// oxlint-disable-next-line unicorn/prefer-add-event-listener
server.onclose = () => {
  session.stop().catch((/** @type {unknown} */ error) => {
    process.stderr.write(`macuse session stop failed: ${String(error)}\n`);
  });
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    (async () => {
      await session.stop();
      await server.close();
    })().catch((/** @type {unknown} */ error) => {
      process.stderr.write(`macuse shutdown failed: ${String(error)}\n`);
    });
  });
await server.connect(new StdioServerTransport());
