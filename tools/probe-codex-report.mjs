import { randomUUID } from "node:crypto";
import { isRecord, sanitizeForLog, summarizeContentBlocks, truncate } from "./probe-codex-core.mjs";

/** @typedef {import("./probe-codex-core.mjs").ProbeStats} ProbeStats */
/** @typedef {import("./probe-codex-core.mjs").ProbeOptions} ProbeOptions */
/**
 * @param {unknown} schema
 * @returns {string}
 */
export function summarizeJsonSchemaType(schema) {
  if (!isRecord(schema)) {
    return "unknown";
  }
  if (typeof schema.type === "string") {
    return schema.type;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.join("|");
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map(summarizeJsonSchemaType).join("|");
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map(summarizeJsonSchemaType).join("|");
  }
  if (schema.const !== undefined) {
    return `const(${JSON.stringify(schema.const)})`;
  }
  if (Array.isArray(schema.enum)) {
    return `enum(${schema.enum.slice(0, 6).join("|")}${schema.enum.length > 6 ? "|…" : ""})`;
  }
  return "unknown";
}

/**
 * @param {unknown} schema
 * @returns {string}
 */
export function summarizeInputSchema(schema) {
  if (!isRecord(schema)) {
    return "(no schema)";
  }
  const props = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const names = Object.keys(props);
  if (names.length === 0) {
    return "(no input properties)";
  }
  return names
    .map(
      (name) => `${name}${required.has(name) ? "*" : ""}:${summarizeJsonSchemaType(props[name])}`,
    )
    .join(", ");
}

/**
 * @param {unknown} initResult
 * @param {unknown} toolsResult
 * @returns {void}
 */
export function printDiscoverSummary(initResult, toolsResult) {
  const init = isRecord(initResult) ? initResult : undefined;
  const tools = isRecord(toolsResult) && Array.isArray(toolsResult.tools) ? toolsResult.tools : [];
  process.stdout.write("Server info:\n");
  process.stdout.write(`${JSON.stringify(sanitizeForLog(init?.serverInfo ?? null), null, 2)}\n`);
  const hasProtocolVersion = Boolean(init?.protocolVersion);
  if (hasProtocolVersion) {
    process.stdout.write(`Protocol version: ${String(init?.protocolVersion)}\n`);
  }
  printCapabilityKeys(init);
  process.stdout.write(`\nTools (${tools.length}):\n`);
  for (const tool of tools) {
    printDiscoveredTool(tool);
  }
}

/**
 * @param {Record<string, unknown> | undefined} init
 */
function printCapabilityKeys(init) {
  const capabilities = isRecord(init?.capabilities) ? init.capabilities : undefined;
  if (capabilities === undefined) {
    return;
  }
  const keys = Object.keys(capabilities).join(", ");
  process.stdout.write(`Server capability keys: ${keys !== "" ? keys : "(none)"}\n`);
}

/**
 * @param {unknown} tool
 */
function printDiscoveredTool(tool) {
  const record = isRecord(tool) ? tool : undefined;
  const described = Boolean(record?.description);
  const description = described ? ` - ${String(truncate(record?.description, 120))}` : "";
  process.stdout.write(`- ${String(record?.name)}${description}\n`);
  process.stdout.write(`  input: ${summarizeInputSchema(record?.inputSchema)}\n`);
}

/**
 * @param {unknown} result
 * @returns {{ isError: boolean, content: unknown, structuredContentKeys: string[], resultKeys: string[] }}
 */
export function summarizeToolResult(result) {
  const record = isRecord(result) ? result : undefined;
  const structured = record?.structuredContent;
  return {
    isError: Boolean(record?.isError),
    content: summarizeContentBlocks(record?.content ?? []),
    structuredContentKeys:
      structured !== null && structured !== undefined && typeof structured === "object"
        ? Object.keys(structured).slice(0, 20)
        : [],
    resultKeys:
      record !== undefined
        ? Object.keys(record).filter((key) => !["content", "structuredContent"].includes(key))
        : [],
  };
}

/**
 * @param {ProbeOptions} options
 * @returns {Record<string, unknown> | undefined}
 */
export function buildRequestMeta(options) {
  if (!options.withTurnMetadata) {
    return;
  }
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  return {
    "x-codex-turn-metadata": {
      session_id: `probe-session-${id}`,
      thread_id: `probe-thread-${id}`,
      turn_id: `probe-turn-${id}`,
      model: "external-probe",
      reasoning_effort: "medium",
      turn_started_at_unix_ms: Date.now(),
    },
  };
}

/**
 * @param {string} toolName
 * @param {unknown} result
 * @param {ProbeStats} stats
 * @returns {void}
 */
export function printGenericToolResultSummary(toolName, result, stats) {
  process.stdout.write(`${toolName} result:\n`);
  process.stdout.write(`${JSON.stringify(summarizeToolResult(result), null, 2)}\n`);
  process.stdout.write(
    `Elicitation stats: ${JSON.stringify({
      seen: stats.elicitations,
      accepted: stats.accepted,
      declined: stats.declined,
      canceled: stats.canceled,
      unknownServerRequests: stats.unknownServerRequests,
    })}\n`,
  );
}

/**
 * @param {string} app
 * @param {unknown} result
 * @param {ProbeStats} stats
 * @returns {void}
 */
export function printToolResultSummary(app, result, stats) {
  process.stdout.write(`get_app_state result for ${app}:\n`);
  process.stdout.write(`${JSON.stringify(summarizeToolResult(result), null, 2)}\n`);
  process.stdout.write(
    `Elicitation stats: ${JSON.stringify({
      seen: stats.elicitations,
      accepted: stats.accepted,
      declined: stats.declined,
      canceled: stats.canceled,
      unknownServerRequests: stats.unknownServerRequests,
    })}\n`,
  );
}
