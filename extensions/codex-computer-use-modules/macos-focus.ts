import { type AppMetadata } from "./core";

import { MacOSNative, type NativeApplication, type NativeObservation } from "../../tools/macos-native.mjs";

export const macosNative = new MacOSNative();

function appMetadata(app: NativeApplication | null): AppMetadata[] | null {
	if (!app) return null;
	return [{
		name: app.name, path: app.path, bundleId: app.bundleId,
		flags: ["frontmost", "running", "native"], running: true, frontmost: true, lastUsed: null,
		line: `${app.name}${app.path ? ` — ${app.path}` : ""}${app.bundleId ? ` — ${app.bundleId}` : ""} [frontmost, running, native]`,
	}];
}

export type NativeFocusObservation = Omit<NativeObservation, "before" | "after"> & {
	before: AppMetadata[] | null;
	after: AppMetadata[] | null;
};

export async function beginFocusObservation(pids: number[] = []) {
	const observation = await macosNative.beginObservation(pids);
	return { id: observation.id, before: appMetadata(observation.before.frontmost) };
}

export async function endFocusObservation(id: string): Promise<NativeFocusObservation> {
	const observation = await macosNative.endObservation(id);
	return { ...observation, before: appMetadata(observation.before.frontmost), after: appMetadata(observation.after.frontmost) };
}

export async function stopNativeObserver(): Promise<void> {
	await macosNative.stop();
}

