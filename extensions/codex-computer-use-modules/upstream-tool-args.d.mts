export const UPSTREAM_TOOL_ARG_KEYS: Readonly<Record<string, readonly string[]>>;
export const HOST_ONLY_TOOL_ARG_KEYS: ReadonlySet<string>;
export function pickUpstreamToolArgs<T>(tool: string, args: Record<string, T>): Record<string, T>;
