import { spawnSync } from "node:child_process";
import { type AppMetadata, type MousePosition } from "./core";

function lsappinfoValue(text: string): string | null {
	return text.match(/="([^"]+)"/)?.[1] ?? text.match(/^[^=]+=([^\n]+)$/)?.[1]?.trim() ?? null;
}

export function getMousePosition(): MousePosition | null {
	const script = "import CoreGraphics; if let e = CGEvent(source: nil) { let p = e.location; print(Int(p.x), Int(p.y)) }";
	const result = spawnSync("swift", ["-e", script], { encoding: "utf8", timeout: 10_000 });
	if (result.status !== 0) return null;
	const [x, y] = result.stdout.trim().split(/\s+/).map((part) => Number(part));
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	return { x, y };
}

export function restoreMousePosition(position: MousePosition | null): boolean {
	if (!position) return false;
	const script = `import CoreGraphics; CGWarpMouseCursorPosition(CGPoint(x: ${Math.trunc(position.x)}, y: ${Math.trunc(position.y)})); CGAssociateMouseAndMouseCursorPosition(1)`;
	const result = spawnSync("swift", ["-e", script], { encoding: "utf8", timeout: 10_000 });
	return result.status === 0;
}

export function nativeFrontmostApps(): AppMetadata[] | null {
	const front = spawnSync("/usr/bin/lsappinfo", ["front"], { encoding: "utf8", timeout: 5_000 });
	const asn = front.stdout?.trim() ?? "";
	if (front.status !== 0 || !asn) return null;
	const read = (field: string) => lsappinfoValue(spawnSync("/usr/bin/lsappinfo", ["info", "-only", field, asn], { encoding: "utf8", timeout: 5_000 }).stdout || "");
	const name = read("name") || "<unknown>";
	const path = read("bundlepath");
	const bundleId = read("bundleid");
	return [{
		name,
		path,
		bundleId,
		flags: ["frontmost", "running", "native"],
		running: true,
		frontmost: true,
		lastUsed: null,
		line: `${name}${path ? ` — ${path}` : ""}${bundleId ? ` — ${bundleId}` : ""} [frontmost, running, native]`,
	}];
}

