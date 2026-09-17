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
	coverage: { applicationActivation: boolean; focusedWindow: Record<string, number>; truncated: boolean; inputAttribution: false };
};
export type NativeAppState = {
	pid: number;
	app: NativeApplication | null;
	accessibilityTrusted: boolean;
	windowsCount: number | null;
	windowsError: number;
	windows: NativeWindow[] | null;
	focusedWindow: NativeWindow | null;
	focusedElement: { token: string; role: string | null; identifier: string | null; selectedTextSettable: boolean; selectedTextError: number } | null;
};
export type NativeTextRequest = {
	pid: number;
	expected: { windowToken: string; windowTitle: string | null; document: string | null; elementToken: string };
	text: string;
};
export type NativeTextResult =
	| { status: "unsupported" | "guard_failed"; mutationAttempted: false; reason: string }
	| { status: "unverified"; mutationAttempted: true; reason: string }
	| { status: "applied"; mutationAttempted: true; verified: true; insertedUTF16Length: number; replacedUTF16Length: number };
export class MacOSNative {
	snapshot(): Promise<NativeSnapshot>;
	beginObservation(pids?: number[]): Promise<{ id: string; before: NativeSnapshot }>;
	endObservation(id: string): Promise<NativeObservation>;
	inspectApp(pid: number): Promise<NativeAppState>;
	replaceSelectedText(args: NativeTextRequest): Promise<NativeTextResult>;
	stop(): Promise<void>;
}
