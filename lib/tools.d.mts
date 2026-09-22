export type ToolSpec = { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false }; annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } };
export const primaryTools: ToolSpec[];
export const tools: ToolSpec[];
