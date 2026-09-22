export type NativeApplication = { pid: number; name: string; bundleId: string | null; path: string | null };
export type NativeWindow = { token: string; title: string | null; document: string | null };
export type NativeSnapshot = { frontmost: NativeApplication | null; focusedWindow: NativeWindow | null };
export type NativeTransition =
	| { kind: "activation"; at: number; app: NativeApplication }
	| { kind: "focused_window"; at: number; pid: number; window: NativeWindow | null };
export type NativeObservation = {
	before: NativeSnapshot;
	after: NativeSnapshot;
	transitions: NativeTransition[];
	coverage: { applicationActivation: boolean; focusedWindow: Record<string, number>; truncated: boolean; inputAttribution: false; windowDetails: "targetAppsOnly" };
};
export type NativeAppState = {
	pid: number;
	app: NativeApplication | null;
	accessibilityTrusted: boolean;
	windowsCount: number | null;
	windowsError: number;
	windows: NativeWindow[] | null;
	focusedWindow: NativeWindow | null;
	focusedElement: {
		token: string;
		role: string | null;
		roleDescription: string | null;
		identifier: string | null;
		title: string | null;
		description: string | null;
		value: string | null;
		selectedTextSettable: boolean;
		selectedTextError: number;
	} | null;
};
export type NativeTextRequest = {
	pid: number;
	expected: { windowToken: string; windowTitle: string | null; document: string | null; elementToken: string; value?: string | null };
	text: string;
};
export type NativeTextResult =
	| { status: "unsupported" | "guard_failed"; mutationAttempted: false; reason: string }
	| { status: "unverified"; mutationAttempted: true; reason: string }
	| { status: "applied"; mutationAttempted: true; verified: true; insertedUTF16Length: number; replacedUTF16Length: number };
export function nativeWindowClosed(before: { title: string | null; url: string | null }, after: NativeAppState | null): boolean;
export function nativeTextUnavailableReason(state: NativeAppState | null): string;
export type NativeRequestOptions = { signal?: AbortSignal };
export class MacOSNative {
	snapshot(options?: NativeRequestOptions): Promise<NativeSnapshot>;
	resolveApp(identifier: string, options?: NativeRequestOptions): Promise<NativeApplication>;
	beginObservation(pids?: number[], options?: NativeRequestOptions): Promise<{ id: string; before: NativeSnapshot }>;
	endObservation(id: string, options?: NativeRequestOptions): Promise<NativeObservation>;
	inspectApp(pid: number, options?: NativeRequestOptions): Promise<NativeAppState>;
	replaceSelectedText(args: NativeTextRequest, options?: NativeRequestOptions): Promise<NativeTextResult>;
	stop(): Promise<void>;
}
