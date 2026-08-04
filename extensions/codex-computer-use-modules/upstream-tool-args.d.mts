export const UPSTREAM_TOOL_ARG_KEYS: Readonly<Record<string, readonly string[]>>;
export function pickUpstreamToolArgs<T>(tool: string, args: Record<string, T>): Record<string, T>;
