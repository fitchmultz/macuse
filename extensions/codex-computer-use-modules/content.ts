import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	isRecord,
	truncateString,
	type ComputerUseToolResult,
	type ContentBlock,
	type FilteredToolResult,
	type ImageContentBlock,
	type JsonValue,
	type SavedImageArtifact,
	type TextContentBlock,
} from "./core";

export function isTextBlock(block: unknown): block is TextContentBlock {
	return isRecord(block) && block.type === "text" && typeof block.text === "string";
}

export function isImageBlock(block: unknown): block is ImageContentBlock {
	return isRecord(block) && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

export function normalizeContent(content: unknown[] | undefined): ContentBlock[] {
	if (!content || content.length === 0) return [{ type: "text", text: "No content returned." }];
	return content.map((block) => {
		if (isTextBlock(block) || isImageBlock(block)) return block;
		return { type: "text", text: JSON.stringify(block) ?? String(block) };
	});
}

export function summarizeContent(content: ContentBlock[] | undefined): string {
	const normalized = normalizeContent(content);
	const text = normalized
		.filter(isTextBlock)
		.map((block) => block.text)
		.join("\n");
	const images = normalized.filter(isImageBlock).length;
	if (text && images > 0) return `${text}\n\n[${images} image block${images === 1 ? "" : "s"} attached]`;
	if (text) return text;
	if (images > 0) return `[${images} image block${images === 1 ? "" : "s"} attached]`;
	return JSON.stringify(normalized.slice(0, 3));
}

export function toolResultText(result: FilteredToolResult): string {
	return (result.content || [])
		.filter(isTextBlock)
		.map((block) => block.text)
		.join("\n");
}

export function imageDimensions(path: string): { width: number | null; height: number | null } {
	const result = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8", timeout: 10_000 });
	if (result.status !== 0) return { width: null, height: null };
	const width = Number((result.stdout.match(/pixelWidth:\s*(\d+)/) || [])[1]);
	const height = Number((result.stdout.match(/pixelHeight:\s*(\d+)/) || [])[1]);
	return {
		width: Number.isFinite(width) ? width : null,
		height: Number.isFinite(height) ? height : null,
	};
}

export function filterToolResult(result: ComputerUseToolResult, opts: { includeImage?: boolean; saveImagePath?: string; maxTextChars: number }): FilteredToolResult {
	const content: ContentBlock[] = [];
	let omittedImages = 0;
	let savedImagePath: string | null = null;
	let savedImageArtifact: SavedImageArtifact | null = null;
	const rawContent = result?.content;
	const blocks = Array.isArray(rawContent)
		? rawContent
		: rawContent === undefined
			? []
			: [{ type: "text", text: `Malformed Computer Use content field: ${truncateString(JSON.stringify(rawContent) ?? String(rawContent), opts.maxTextChars)}` }];
	for (const block of blocks) {
		if (isTextBlock(block)) {
			content.push({ ...block, text: truncateString(block.text, opts.maxTextChars) });
		} else if (isImageBlock(block)) {
			if (opts.saveImagePath && !savedImagePath) {
				const outPath = path.resolve(opts.saveImagePath);
				mkdirSync(path.dirname(outPath), { recursive: true });
				const imageData = Buffer.from(block.data, "base64");
				writeFileSync(outPath, imageData);
				savedImagePath = outPath;
				const dimensions = imageDimensions(outPath);
				savedImageArtifact = {
					path: outPath,
					bytes: imageData.byteLength,
					sha256: createHash("sha256").update(imageData).digest("hex"),
					width: dimensions.width,
					height: dimensions.height,
				};
			}
			if (opts.includeImage) content.push(block);
			else omittedImages += 1;
		} else {
			content.push(block as ContentBlock);
		}
	}
	return {
		content: normalizeContent(content),
		isError: Boolean(result?.isError ?? result?.is_error ?? false),
		meta: (result?._meta ?? result?.meta ?? null) as JsonValue,
		omittedImages,
		savedImagePath,
		savedImageArtifact,
	};
}

