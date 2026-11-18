import {
  Container,
  Spacer,
  Text,
  replaceControlCharacters,
  stripTerminalSequences,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  truncateToVisualLines,
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";

export type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const stringField = (
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
};

export const booleanField = (
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined => {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
};

export const numberField = (
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined => {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export const arrayField = (record: Record<string, unknown> | undefined, key: string): unknown[] => {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
};

/** Remove terminal escape sequences and C0/C1 control characters from single-line labels/notices. */
export const sanitizeInlineText = (value: string): string =>
  replaceControlCharacters(stripTerminalSequences(value)).trim();

/** Remove terminal escape sequences and C0/C1 control characters while preserving multiline breaks. */
export const sanitizeMultilineText = (value: string): string =>
  value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => replaceControlCharacters(stripTerminalSequences(line.replace(/\t/g, "   "))))
    .join("\n");

export const clipInline = (value: string, maxWidth = 72): string =>
  truncateToWidth(sanitizeInlineText(value), maxWidth, "...");

export const expandHint = (
  theme: Theme,
  hidden: number,
  noun: string,
  context: RenderContext,
): string =>
  `${theme.fg("muted", `... (${hidden} more ${noun},`)} ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;

export class VisualPreview implements Component {
  readonly #text: string;
  readonly #maxVisualLines: number;
  readonly #keep: "start" | "end";
  readonly #formatHint: (hidden: number) => string;
  #cachedWidth: number | undefined;
  #cachedLines: ReturnType<Component["render"]> | undefined;

  constructor(options: {
    text: string;
    maxVisualLines: number;
    keep: "start" | "end";
    formatHint: (hidden: number) => string;
  }) {
    this.#text = options.text;
    this.#maxVisualLines = options.maxVisualLines;
    this.#keep = options.keep;
    this.#formatHint = options.formatHint;
  }

  render(width: number): ReturnType<Component["render"]> {
    if (this.#cachedLines === undefined || this.#cachedWidth !== width) {
      const preview = truncateToVisualLines(this.#text, this.#maxVisualLines, width, 0, this.#keep);
      if (preview.skippedCount > 0) {
        const hint = truncateToWidth(this.#formatHint(preview.skippedCount), width, "...");
        this.#cachedLines =
          this.#keep === "start" ? [...preview.visualLines, hint] : [hint, ...preview.visualLines];
      } else {
        this.#cachedLines = preview.visualLines;
      }
      this.#cachedWidth = width;
    }
    return this.#cachedLines;
  }

  invalidate(): void {
    this.#cachedWidth = undefined;
    this.#cachedLines = undefined;
  }
}

export const resetContainer = (lastComponent: Component | undefined): Container => {
  const container = lastComponent instanceof Container ? lastComponent : new Container();
  container.clear();
  return container;
};

export const extractTextBlocks = (content: unknown): string[] => {
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts;
};

export const countImageBlocks = (content: unknown): number => {
  if (!Array.isArray(content)) {
    return 0;
  }
  let count = 0;
  for (const part of content) {
    if (isRecord(part) && part.type === "image") {
      count++;
    }
  }
  return count;
};

export const extractMacuseMeta = (details: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(details) || !isRecord(details.macuse)) {
    return undefined;
  }
  return details.macuse;
};

export const styleOutputBlocks = (blocks: string[], theme: Theme, isError: boolean): string => {
  const color = isError ? "error" : "toolOutput";
  return blocks
    .map((block) => sanitizeMultilineText(block))
    .filter((block) => block.trim() !== "")
    .join("\n")
    .split("\n")
    .map((line) => theme.fg(color, line))
    .join("\n");
};

export const addPreviewText = (
  component: Container,
  styled: string,
  options: {
    expanded: boolean;
    maxVisualLines: number;
    theme: Theme;
    context: RenderContext;
  },
): void => {
  if (options.expanded) {
    component.addChild(new Text(styled, 0, 0));
    return;
  }
  component.addChild(
    new VisualPreview({
      text: styled,
      maxVisualLines: options.maxVisualLines,
      keep: "start",
      formatHint: (hidden) => expandHint(options.theme, hidden, "lines", options.context),
    }),
  );
};

export const renderFallbackBody = (
  component: Container,
  result: AgentToolResult<unknown>,
  renderOptions: {
    options: ToolRenderResultOptions;
    theme: Theme;
    context: RenderContext;
    maxVisualLines: number;
  },
): void => {
  const { options, theme, context, maxVisualLines } = renderOptions;
  const styled = styleOutputBlocks(extractTextBlocks(result.content), theme, context.isError);
  if (styled !== "") {
    component.addChild(new Spacer(1));
    addPreviewText(component, styled, {
      expanded: options.expanded,
      maxVisualLines,
      theme,
      context,
    });
    return;
  }
  const imageCount = countImageBlocks(result.content);
  const placeholder = options.isPartial ? "Running..." : "(no output)";
  const fallback =
    !context.showImages && imageCount > 0 ? `[${imageCount} screenshot(s)]` : placeholder;
  component.addChild(new Spacer(1));
  component.addChild(new Text(theme.fg("muted", fallback), 0, 0));
};
