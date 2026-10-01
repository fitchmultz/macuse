import type { ExtensionContext, MessageEndEvent } from '@earendil-works/pi-coding-agent';
type AgentMessage = MessageEndEvent['message'];
export function canRestoreMacuseImages(model: { id: string; api: string } | undefined): boolean;
export function retainMacuseOriginals(message: AgentMessage): void;
export function restoreMacuseImages(payload: unknown, retained: Map<string, AgentMessage>, model: { id: string; api: string } | undefined): unknown;
export function macuseImageIndex(): {
  reset(): void;
  messageEnd(message: AgentMessage): void;
  select(manager: ExtensionContext['sessionManager'], messages: AgentMessage[]): Map<string, AgentMessage>;
};
