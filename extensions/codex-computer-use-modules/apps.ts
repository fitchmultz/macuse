import {
	truncateString,
	type AppMetadata,
	type ContentBlock,
	type FocusSnapshot,
} from "./core";
import { contentText } from "./elements-state";

export function filteredAppListLines(content: ContentBlock[], opts: { runningOnly?: boolean; filter?: string }): string[] {
	let lines = contentText(content).split("\n").map((line) => line.trim()).filter(Boolean);
	if (opts.runningOnly) lines = lines.filter((line: string) => /\[(?:[^\]]*,\s*)?(?:frontmost,\s*)?running(?:[,\]])/.test(line) || line.includes("[frontmost, running"));
	if (opts.filter) {
		const needle = opts.filter.toLowerCase();
		lines = lines.filter((line: string) => line.toLowerCase().includes(needle));
	}
	return lines;
}

export function parseAppListLine(line: string): AppMetadata {
	const [left, flagsPart = ""] = line.split(/\s+\[([^\]]+)\]\s*$/).filter((part) => part !== undefined);
	const parts = (left || line).split(" — ").map((part) => part.trim());
	const flags = flagsPart
		.split(",")
		.map((flag) => flag.trim())
		.filter(Boolean);
	const lastUsedFlag = flags.find((flag) => /^last[- ]used:/i.test(flag));
	return {
		name: parts[0] || line,
		path: parts[1] || null,
		bundleId: parts[2] || null,
		flags,
		running: flags.some((flag) => flag.toLowerCase() === "running"),
		frontmost: flags.some((flag) => flag.toLowerCase() === "frontmost"),
		lastUsed: lastUsedFlag?.replace(/^last[- ]used:\s*/i, "") ?? null,
		line,
	};
}

export function parseAppListContent(content: ContentBlock[], opts: { runningOnly?: boolean; filter?: string } = {}): AppMetadata[] {
	return filteredAppListLines(content, opts).map(parseAppListLine);
}

export function filterAppListContent(content: ContentBlock[], opts: { runningOnly?: boolean; filter?: string; maxTextChars: number }): ContentBlock[] {
	const lines = filteredAppListLines(content, opts);
	const apps = lines.map(parseAppListLine);
	const frontmost = apps.filter((app) => app.frontmost).map((app) => app.name).join(", ") || "<none>";
	const summary = `Structured app summary: count=${apps.length}; frontmost=${frontmost}; fields=name,path,bundleId,flags,running,frontmost,lastUsed`;
	const text = lines.length > 0 ? `${summary}\n${lines.join("\n")}` : "No apps matched the requested filter.";
	return [{ type: "text", text: truncateString(text, opts.maxTextChars) }];
}


export function focusSnapshot(before: AppMetadata[] | null, after: AppMetadata[] | null): FocusSnapshot {
	const afterNames = (after ?? []).map((app) => app.name);
	const beforeNames = (before ?? []).map((app) => app.name);
	const changed = before && after ? beforeNames.join("|") !== afterNames.join("|") : null;
	return {
		frontmost: after ?? [],
		frontmostNames: afterNames,
		changed,
		before,
		after,
	};
}

export function appMatches(app: AppMetadata, target: string): boolean {
	const expected = target.toLowerCase();
	return [app.name, app.path, app.bundleId]
		.filter((value): value is string => typeof value === "string")
		.some((value) => value.toLowerCase() === expected || value.toLowerCase().includes(expected));
}

export function focusSummaryText(focus: FocusSnapshot, targetApp?: string): string {
	const before = focus.before?.map((app) => app.name).join(", ") || "<unknown>";
	const after = focus.after?.map((app) => app.name).join(", ") || "<unknown>";
	const targetBecameFrontmost = targetApp ? Boolean(focus.after?.some((app) => appMatches(app, targetApp)) && !focus.before?.some((app) => appMatches(app, targetApp))) : null;
	const targetFrontmostAfter = targetApp ? Boolean(focus.after?.some((app) => appMatches(app, targetApp))) : null;
	return `Focus summary: before=${before}; after=${after}; frontmostChanged=${focus.changed ?? "unknown"}${targetApp ? `; targetAppFrontmostAfter=${targetFrontmostAfter}; targetAppBecameFrontmost=${targetBecameFrontmost}` : ""}`;
}

