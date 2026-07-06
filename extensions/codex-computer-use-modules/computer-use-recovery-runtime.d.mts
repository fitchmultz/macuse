export type ComputerUseRestartTarget = {
	pid: number;
	cmd: string;
	signal: "SIGTERM" | "SIGKILL" | "already-exited" | "failed";
	error?: string;
};

export type ComputerUseRecoveryScope = "app-server-session" | "computer-use-runtime";

export type ComputerUseRestartSummary = {
	reason: string;
	scope: ComputerUseRecoveryScope;
	startedAt: string;
	finishedAt: string;
	targets: ComputerUseRestartTarget[];
};

export function isRecoverableComputerUseSessionText(text: string): boolean;
export function sanitizeRecoverableComputerUseText(text: string): { text: string; forcedError: boolean };
export function shouldAutoRecoverComputerUse(tool: string, text: string, enabled?: boolean): boolean;
export function appServerSessionRecoverySummary(reason: string): ComputerUseRestartSummary;
export function withReadOnlyComputerUseRecovery<T>(opts: {
	tool: string;
	enabled?: boolean;
	run: () => Promise<T>;
	resultText: (result: T) => string;
	recover: (reason: string) => Promise<ComputerUseRestartSummary>;
	errorMessage?: (error: unknown) => string;
	errorFactory?: (message: string, error: unknown) => Error;
}): Promise<T>;
export function restartComputerUseRuntime(reason: string): ComputerUseRestartSummary;
