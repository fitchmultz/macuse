import type { MacOSNative, NativeApplication, NativeObservation } from "../tools/macos-native.mjs";
import type { AppObservation } from "./app-state.mjs";

export type InsertTextInput = {
	app: string;
	text: string;
	allowMutating?: boolean;
	safetyNote?: string;
	expectedTitle?: string;
	expectedUrl?: string;
};
export type InsertTextResult = {
	content: { type: "text"; text: string }[];
	isError: boolean;
	details: { macuse: {
		tool: "insert_text";
		app: string;
		dispatched: boolean;
		outcome: "not_dispatched" | "unknown" | "verified";
		target?: NativeApplication;
		insertedUTF16Length?: number;
		replacedUTF16Length?: number;
		focus?: (NativeObservation & { observationAvailable: true }) | { observationAvailable: false; observationError: string; inputAttribution: false };
	} };
};
export function insertText(native: MacOSNative, input: InsertTextInput, observation: AppObservation | undefined, options?: { signal?: AbortSignal }): Promise<InsertTextResult>;
