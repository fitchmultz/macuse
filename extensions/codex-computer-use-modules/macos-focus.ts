import { spawnSync } from "node:child_process";
import { type AppMetadata, type MousePosition } from "./core";

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

export function restoreFrontmostApp(app: AppMetadata | null): boolean {
	if (!app) return false;
	const args = app.bundleId ? ["-b", app.bundleId] : app.path ? [app.path] : [];
	if (args.length === 0) return false;
	const result = spawnSync("/usr/bin/open", args, { encoding: "utf8", timeout: 10_000 });
	return result.status === 0;
}

