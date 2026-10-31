// Node clamps setTimeout delays above 2^31-1 to 1 ms; the MCP request
// needs 15 seconds beyond the native execution deadline for settlement.
// https://nodejs.org/docs/latest-v24.x/api/timers.html#settimeoutcallback-delay-args
export const CUA_REQUEST_GRACE_MS = 15_000;
export const MAX_CUA_TIMEOUT_MS = 2_147_483_647 - CUA_REQUEST_GRACE_MS;
