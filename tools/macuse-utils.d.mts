export const TOOLS_DIR: string;
export const REPO_ROOT: string;
export const VERSION: string;
export const DEFAULT_CHATGPT_RESOURCES: string;
export const DEFAULT_BUNDLED_COMPUTER_USE_PLUGIN_DIR: string;
export const DEFAULT_CODEX_HOME: string;
export const DEFAULT_COMPUTER_USE_PLUGIN_ROOT: string;
export const DEFAULT_COMPUTER_USE_APP: string;
export const DEFAULT_BUNDLED_COMPUTER_USE_CLIENT: string;
export const DEFAULT_COMPUTER_USE_CLIENT_CWD: string;
export const DEFAULT_COMPUTER_USE_PLUGIN_DIR: string | null;

export interface McpServerSpec {
  pluginDir: string;
  args: string[];
  tools: string[];
}
export const MCP_SERVERS: Readonly<
  Record<"computer-use" | "event-stream" | "computer-history", McpServerSpec>
>;
export const COMPUTER_USE_TOOL_NAMES: string[];

export function mcpServerForTool(
  tool: string,
): "computer-use" | "event-stream" | "computer-history";
export function mcpServerConfigs(): Record<
  string,
  {
    command: string;
    args: string[];
    cwd: string;
    env_vars: string[];
    enabled: boolean;
  }
>;
export function discoverComputerUsePluginDir(
  root?: string,
  opts?: { fallback?: boolean | undefined },
): string | null;
export function nowIsoForPath(date?: Date): string;
export function ensureDir(path: string): void;
export function writeJsonFile(path: string, value: unknown): void;
/** Parsed JSON is untrusted until the caller validates it. */
export function readJsonFile(path: string): unknown;
export function isExecutable(path: string): boolean;
export function fileExists(path: string): boolean;

export interface RunCommandResult {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  durationMs: number;
  status: number | null;
  signal: string | null;
  error: string | null;
  stdout: string;
  stderr: string;
  ok: boolean;
}
export interface RunCommandOptions {
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  input?: string | undefined;
  timeoutMs?: number | undefined;
  maxBuffer?: number | undefined;
}
export function runCommand(
  name: string,
  command: string,
  args?: string[],
  opts?: RunCommandOptions,
): RunCommandResult;
export function mustRun(
  name: string,
  command: string,
  args?: string[],
  opts?: RunCommandOptions,
): RunCommandResult;
/** Parsed JSON is untrusted until the caller validates it. */
export function parseJsonOutput(label: string, text: string): unknown;
export function frontmostApp(): {
  asn: string;
  bundleId: string | null;
  name: string | null;
} | null;
export function mousePosition(): { x: number; y: number } | null;
export function sha256File(path: string): string;
export function imageInfo(path: string): {
  path: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
} | null;
export function toolText(
  result: { content?: Array<{ type?: unknown; text?: unknown }> } | null | undefined,
): string;
export function stepText(
  step: { result?: Parameters<typeof toolText>[0] } | null | undefined,
): string;
export function markdownEscape(value: unknown): string;
export function markdownTable(headers: unknown[], rows: unknown[][]): string;
export function commandLine(command: string, args?: string[]): string;
/** First nonempty text value, or null. */
export function firstText(values: (string | null | undefined)[]): string | null;
