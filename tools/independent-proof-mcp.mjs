#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { IndependentProofSession } from "../lib/independent-proof-session.mjs";
import {
  callIndependentProof,
  independentProofFailure,
  independentProofTools,
} from "../lib/independent-proof-tools.mjs";
import { VERSION } from "./macuse-utils.mjs";

const session = new IndependentProofSession();
const server = new Server(
  { name: "macuse-independent-proof", version: VERSION },
  { capabilities: { tools: {} } },
);
/** @type {Promise<void> | undefined} */
let closing;
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: independentProofTools }));
server.setRequestHandler(CallToolRequestSchema, async (request, { signal }) => {
  if (closing) {
    const { content, isError, details } = independentProofFailure(
      new Error("Proof server is closing; no execution admitted."),
      { notDispatched: true },
    );
    return { content, isError, _meta: details };
  }
  const { content, isError, details } = await callIndependentProof(
    session,
    request.params.name,
    request.params.arguments ?? {},
    { signal },
  );
  return { content, isError, _meta: details };
});
/** @returns {Promise<void>} */
const close = () => {
  if (closing === undefined) {
    closing = (async () => {
      try {
        const stopped = await session.stop();
        if (!stopped.settled || !stopped.workerStopped || !stopped.nativeStopped) {
          console.error(
            "Independent proof shutdown is unsettled; do not infer GUI cancellation or replay actions.",
          );
          process.exitCode = 1;
        }
      } finally {
        await server.close();
      }
    })();
  }
  return closing;
};
const shutdown = () => {
  close().catch((/** @type {unknown} */ error) => {
    console.error(
      `Independent proof shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
};
server.onclose = shutdown;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, shutdown);
await server.connect(new StdioServerTransport());
