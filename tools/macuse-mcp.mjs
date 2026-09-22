#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MacuseSession } from '../lib/macuse-session.mjs';
import { tools } from '../lib/tools.mjs';
import { VERSION } from './macuse-utils.mjs';

const session = new MacuseSession({ cwd: process.env.MACUSE_CWD ?? process.cwd() });
const server = new Server({ name: 'macuse', version: VERSION }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request, { signal }) => {
  try {
    const { content, isError, details } = await session.callTool(request.params.name, request.params.arguments, { signal });
    return { content, isError, _meta: details };
  } catch (error) {
    return { content: [{ type: 'text', text: `macuse failed: ${error.message}. Inspect application state; do not automatically replay an action.` }], isError: true, _meta: { macuse: { outcome: 'unknown' } } };
  }
});
server.onclose = () => { void session.stop(); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await session.stop(); await server.close(); });
await server.connect(new StdioServerTransport());
