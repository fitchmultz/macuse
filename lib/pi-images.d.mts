import type { ExtensionContext, MessageEndEvent } from '@earendil-works/pi-coding-agent';
import type { ModelImageResizeOptions } from '@earendil-works/pi-ai';
type AgentMessage = MessageEndEvent['message'];
export function canRestoreMacuseImages(model: { id: string; api: string } | undefined): boolean;
export function retainMacuseOriginals(message: AgentMessage, resizeOptions?: ModelImageResizeOptions): Promise<void>;
export function restoreMacuseImages(payload: unknown, retained: Map<string, AgentMessage>, model: { id: string; api: string } | undefined): unknown;
export function macuseImageIndex(): {
  reset(): void;
  messageEnd(message: AgentMessage, resizeOptions?: ModelImageResizeOptions): Promise<void>;
  select(manager: ExtensionContext['sessionManager'], messages: AgentMessage[], resizeOptions?: ModelImageResizeOptions): Promise<Map<string, AgentMessage>>;
};
