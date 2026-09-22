export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type MacuseResult = { content: Content[]; isError: boolean; details: { macuse: Record<string, unknown> } };
export class MacuseSession {
  constructor(options?: { cwd?: string });
  callTool(tool: string, input?: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number; onUpdate?: (result: MacuseResult) => void }): Promise<MacuseResult>;
  reset(): Promise<MacuseResult>;
  status(): { computer: unknown; auxiliary: unknown };
  stop(): Promise<void>;
}
