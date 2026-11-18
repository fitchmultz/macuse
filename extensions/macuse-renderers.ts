import {
  Spacer,
  Text,
  truncateToWidth,
  type Component,
  type Container,
} from "@earendil-works/pi-tui";
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { MACUSE_API_DOC } from "../lib/cua-banner.mjs";
import {
  addPreviewText,
  arrayField,
  booleanField,
  clipInline,
  countImageBlocks,
  expandHint,
  extractMacuseMeta,
  extractTextBlocks,
  isRecord,
  numberField,
  renderFallbackBody,
  resetContainer,
  sanitizeMultilineText,
  stringField,
  styleOutputBlocks,
  type RenderContext,
} from "./macuse-render-utils";

const CODE_PREVIEW_LINES = 6;
const OUTPUT_PREVIEW_LINES = 6;
const ACTION_PREVIEW_COUNT = 6;
const OBSERVATION_PREVIEW_COUNT = 3;

const formatMacuseCallHeader = (args: unknown, theme: Theme): string => {
  const record = isRecord(args) ? args : undefined;
  const parts = [theme.fg("toolTitle", theme.bold("macuse"))];
  const apps = arrayField(record, "apps")
    .filter((app): app is string => typeof app === "string")
    .map((app) => clipInline(app, 36))
    .filter((app) => app !== "");
  if (apps.length > 0) {
    parts.push(theme.fg("accent", truncateToWidth(apps.join(", "), 64, "...")));
  }
  if (booleanField(record, "allowMutating") === true) {
    parts.push(theme.fg("warning", "[mutating]"));
  }
  const timeoutMs = numberField(record, "timeoutMs");
  if (timeoutMs !== undefined && timeoutMs !== 90_000) {
    parts.push(theme.fg("muted", `(${Math.max(1, Math.round(timeoutMs / 1000))}s)`));
  }
  if (record !== undefined && "code" in record && record.code !== undefined) {
    if (typeof record.code !== "string") {
      parts.push(theme.fg("error", "[invalid arg]"));
    }
  }
  return parts.join(" ");
};

const formatMacuseCallMetadata = (
  args: unknown,
  theme: Theme,
  expanded: boolean,
): string | undefined => {
  if (!isRecord(args)) {
    return undefined;
  }
  const metaParts: string[] = [];
  const safetyNote = stringField(args, "safetyNote");
  if (safetyNote !== undefined && safetyNote.trim() !== "") {
    metaParts.push(`note: ${clipInline(safetyNote, expanded ? 200 : 64)}`);
  }
  const saveImagePath = stringField(args, "saveImagePath");
  if (saveImagePath !== undefined && saveImagePath.trim() !== "") {
    metaParts.push(`save: ${clipInline(saveImagePath, 48)}`);
  }
  return metaParts.length > 0 ? theme.fg("muted", metaParts.join(" · ")) : undefined;
};

const statusBadge = (meta: Record<string, unknown>, theme: Theme, isError: boolean): string => {
  if (
    booleanField(meta, "dispatched") === false ||
    stringField(meta, "outcome") === "not_dispatched"
  ) {
    return theme.fg("error", "✗ refused (not dispatched)");
  }
  const rawStatus = stringField(meta, "status");
  if (rawStatus === "unknown") {
    return theme.fg("warning", "? unknown outcome");
  }
  if (rawStatus === "failed" || isError) {
    return theme.fg("error", "✗ failed");
  }
  if (rawStatus === "running") {
    return theme.fg("warning", "… running");
  }
  return theme.fg("success", "✓ completed");
};

const formatStatusLine = (
  meta: Record<string, unknown>,
  theme: Theme,
  context: RenderContext,
  imageCount: number,
): string => {
  const parts = [statusBadge(meta, theme, context.isError)];
  if (booleanField(meta, "kernelReset") === true) {
    const interruption = stringField(meta, "interruption");
    const suffix =
      interruption !== undefined && interruption !== "" ? ` (${clipInline(interruption, 24)})` : "";
    parts.push(theme.fg("warning", `[kernel reset${suffix}]`));
  }
  const savedImage = isRecord(meta.savedImage) ? meta.savedImage : undefined;
  const savedPath = stringField(savedImage, "path");
  if (savedPath !== undefined && savedPath !== "") {
    parts.push(theme.fg("muted", `saved: ${clipInline(savedPath, 48)}`));
  }
  if (!context.showImages && imageCount > 0) {
    parts.push(theme.fg("muted", `[${imageCount} screenshot(s)]`));
  }
  return parts.join(" ");
};

const formatActionTarget = (target: Record<string, unknown>): string => {
  const role = clipInline(stringField(target, "role") ?? "element", 24);
  const name = clipInline(stringField(target, "name") ?? "", 32);
  const index = stringField(target, "index") ?? "";
  const named = name !== "" && name !== role ? ` "${name}"` : "";
  const at = index !== "" ? ` #${clipInline(index, 12)}` : "";
  return `${role}${named}${at}`;
};

const actionStatusIcon = (
  outcome: string | undefined,
  error: string | undefined,
  theme: Theme,
): string => {
  if ((error !== undefined && error !== "") || outcome === "not_dispatched") {
    return theme.fg("error", "✗");
  }
  if (outcome === "unknown") {
    return theme.fg("warning", "?");
  }
  return theme.fg("success", "✓");
};

const actionErrorSegment = (
  rawAction: Record<string, unknown>,
  theme: Theme,
  expanded: boolean,
): string | undefined => {
  const error = stringField(rawAction, "error");
  if (error === undefined || error === "") {
    return undefined;
  }
  return theme.fg("error", clipInline(error, expanded ? 200 : 72));
};

const actionVerificationSegment = (
  rawAction: Record<string, unknown>,
  theme: Theme,
): string | undefined => {
  const verification = stringField(rawAction, "verification");
  if (verification === undefined || verification === "" || verification === "none") {
    return undefined;
  }
  return theme.fg("dim", `[${clipInline(verification, 28)}]`);
};

const formatActionLine = (
  rawAction: unknown,
  theme: Theme,
  expanded: boolean,
): string | undefined => {
  if (!isRecord(rawAction)) {
    return undefined;
  }
  const method = clipInline(stringField(rawAction, "method") ?? "action", 28);
  const app = clipInline(stringField(rawAction, "app") ?? "", 32);
  const icon = actionStatusIcon(
    stringField(rawAction, "outcome"),
    stringField(rawAction, "error"),
    theme,
  );
  const segments = [`${icon} ${theme.fg("toolTitle", method)}`];
  if (app !== "") {
    segments.push(theme.fg("accent", app));
  }
  if (isRecord(rawAction.target)) {
    segments.push(theme.fg("muted", formatActionTarget(rawAction.target)));
  }
  const verification = actionVerificationSegment(rawAction, theme);
  if (verification !== undefined) {
    segments.push(verification);
  }
  const error = actionErrorSegment(rawAction, theme, expanded);
  if (error !== undefined) {
    segments.push(error);
  }
  return segments.join(" ");
};

const focusedSummary = (focused: Record<string, unknown>): string => {
  const role = clipInline(stringField(focused, "role") ?? "element", 20);
  const name = clipInline(stringField(focused, "name") ?? "", 28);
  const label = name !== "" && name !== role ? `${role} "${name}"` : role;
  return `[focus: ${label}]`;
};

const formatObservationLine = (rawObservation: unknown, theme: Theme): string | undefined => {
  if (!isRecord(rawObservation)) {
    return undefined;
  }
  const app = clipInline(stringField(rawObservation, "app") ?? "app", 32);
  const parts = [`Observed ${theme.fg("accent", app)}`];
  const title = stringField(rawObservation, "title");
  if (title !== undefined && title !== "") {
    parts.push(theme.fg("muted", `— "${clipInline(title, 48)}"`));
  }
  const url = stringField(rawObservation, "url");
  if (url !== undefined && url !== "") {
    parts.push(theme.fg("dim", `(${clipInline(url, 48)})`));
  }
  if (isRecord(rawObservation.focused)) {
    parts.push(theme.fg("dim", focusedSummary(rawObservation.focused)));
  }
  return parts.join(" ");
};

const focusFrontmostSuffix = (focus: Record<string, unknown>): string => {
  const after = isRecord(focus.after) ? focus.after : undefined;
  const frontmost = isRecord(after?.frontmost) ? after.frontmost : undefined;
  const frontmostName = stringField(frontmost, "name");
  if (frontmostName === undefined || frontmostName === "") {
    return "";
  }
  return ` (frontmost: ${clipInline(frontmostName, 32)})`;
};

const formatFocusLine = (
  focus: Record<string, unknown>,
  theme: Theme,
  expanded: boolean,
): string | undefined => {
  const observationError = stringField(focus, "observationError");
  if (observationError !== undefined && observationError !== "") {
    return theme.fg("warning", `Focus tracking: ${clipInline(observationError, 72)}`);
  }
  if (booleanField(focus, "observationAvailable") !== true) {
    return undefined;
  }
  const transitions = arrayField(focus, "transitions");
  if (!expanded && transitions.length === 0) {
    return undefined;
  }
  return theme.fg(
    "muted",
    `Focus transitions: ${transitions.length}${focusFrontmostSuffix(focus)}`,
  );
};

const isActionSummaryJson = (block: string, actionCount: number): boolean => {
  if (actionCount === 0 || !block.startsWith("{")) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(block);
    return (
      isRecord(parsed) && typeof parsed.actionCount === "number" && Array.isArray(parsed.actions)
    );
  } catch {
    return false;
  }
};

const filterCollapsedTextBlocks = (
  blocks: string[],
  meta: Record<string, unknown> | undefined,
  actionCount: number,
): string[] => {
  const hasFocus = isRecord(meta?.focus);
  return blocks.filter((block) => {
    if (block === MACUSE_API_DOC) {
      return false;
    }
    if (isActionSummaryJson(block, actionCount)) {
      return false;
    }
    if (hasFocus && block.startsWith("Focus observation:")) {
      return false;
    }
    return true;
  });
};

const appendProvisionalActions = (
  component: Container,
  provisionalActions: unknown[],
  theme: Theme,
): void => {
  const shown = provisionalActions.slice(-4);
  const lines = shown.filter(isRecord).map((item) => {
    const method = clipInline(stringField(item, "method") ?? "action", 28);
    const app = clipInline(stringField(item, "app") ?? "", 32);
    return theme.fg("muted", `… ${method}${app !== "" ? ` ${app}` : ""}`);
  });
  if (lines.length > 0) {
    component.addChild(new Text(lines.join("\n"), 0, 0));
  }
};

const appendStructuredSections = (
  component: Container,
  meta: Record<string, unknown>,
  renderOptions: { options: ToolRenderResultOptions; theme: Theme; context: RenderContext },
): number => {
  const { options, theme, context } = renderOptions;
  const actionLines = arrayField(meta, "actions")
    .map((item) => formatActionLine(item, theme, options.expanded))
    .filter((line): line is string => line !== undefined);
  if (actionLines.length > 0) {
    const shown = options.expanded ? actionLines : actionLines.slice(-ACTION_PREVIEW_COUNT);
    if (shown.length < actionLines.length) {
      shown.unshift(
        expandHint(theme, actionLines.length - shown.length, "earlier actions", context),
      );
    }
    component.addChild(new Text(shown.join("\n"), 0, 0));
  }
  const obsLines = arrayField(meta, "observations")
    .map((item) => formatObservationLine(item, theme))
    .filter((line): line is string => line !== undefined);
  if (obsLines.length > 0) {
    const shown = options.expanded ? obsLines : obsLines.slice(0, OBSERVATION_PREVIEW_COUNT);
    if (shown.length < obsLines.length) {
      shown.push(
        theme.fg("muted", `... (+${obsLines.length - shown.length} more observed app(s))`),
      );
    }
    component.addChild(new Text(shown.join("\n"), 0, 0));
  }
  if (isRecord(meta.focus)) {
    const focusLine = formatFocusLine(meta.focus, theme, options.expanded);
    if (focusLine !== undefined) {
      component.addChild(new Text(focusLine, 0, 0));
    }
  }
  return actionLines.length;
};

export const macuseToolRenderers: ToolRenderers = {
  renderCall(args: unknown, theme: Theme, context: RenderContext): Component {
    const component = resetContainer(context.lastComponent);
    component.addChild(new Text(formatMacuseCallHeader(args, theme), 0, 0));
    const metadata = formatMacuseCallMetadata(args, theme, context.expanded);
    if (metadata !== undefined) {
      component.addChild(new Text(metadata, 0, 0));
    }
    const rawCode = isRecord(args) ? stringField(args, "code") : undefined;
    if (rawCode !== undefined && rawCode.trim() !== "") {
      const styledCode = sanitizeMultilineText(rawCode.trimEnd())
        .split("\n")
        .map((line) => theme.fg("toolOutput", line))
        .join("\n");
      addPreviewText(component, styledCode, {
        expanded: context.expanded,
        maxVisualLines: CODE_PREVIEW_LINES,
        theme,
        context,
      });
    }
    return component;
  },

  renderResult(
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContext,
  ): Component {
    const component = resetContainer(context.lastComponent);
    const meta = extractMacuseMeta(result.details);
    if (meta === undefined) {
      renderFallbackBody(component, result, {
        options,
        theme,
        context,
        maxVisualLines: OUTPUT_PREVIEW_LINES,
      });
      return component;
    }
    const imageCount = countImageBlocks(result.content);
    component.addChild(new Spacer(1));
    component.addChild(new Text(formatStatusLine(meta, theme, context, imageCount), 0, 0));
    if (options.isPartial) {
      appendProvisionalActions(component, arrayField(meta, "provisionalActions"), theme);
      const partialStyled = styleOutputBlocks(
        extractTextBlocks(result.content),
        theme,
        context.isError,
      );
      if (partialStyled !== "") {
        addPreviewText(component, partialStyled, {
          expanded: options.expanded,
          maxVisualLines: OUTPUT_PREVIEW_LINES,
          theme,
          context,
        });
      }
      return component;
    }
    const actionCount = appendStructuredSections(component, meta, { options, theme, context });
    const rawBlocks = extractTextBlocks(result.content);
    const visibleBlocks = options.expanded
      ? rawBlocks
      : filterCollapsedTextBlocks(rawBlocks, meta, actionCount);
    const styled = styleOutputBlocks(visibleBlocks, theme, context.isError);
    if (styled !== "") {
      component.addChild(new Spacer(1));
      addPreviewText(component, styled, {
        expanded: options.expanded,
        maxVisualLines: OUTPUT_PREVIEW_LINES,
        theme,
        context,
      });
    }
    return component;
  },
};

export const macuseResetToolRenderers: ToolRenderers = {
  renderCall(_args: unknown, theme: Theme, context: RenderContext): Component {
    const component = resetContainer(context.lastComponent);
    component.addChild(new Text(theme.fg("toolTitle", theme.bold("macuse_reset")), 0, 0));
    return component;
  },

  renderResult(
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContext,
  ): Component {
    const component = resetContainer(context.lastComponent);
    renderFallbackBody(component, result, { options, theme, context, maxVisualLines: 4 });
    return component;
  },
};

export const auxiliaryToolRenderers = (name: string): ToolRenderers => ({
  renderCall(args: unknown, theme: Theme, context: RenderContext): Component {
    const component = resetContainer(context.lastComponent);
    const record = isRecord(args) ? args : undefined;
    const header = [theme.fg("toolTitle", theme.bold(name))];
    if (booleanField(record, "allowRecording") === true) {
      header.push(theme.fg("warning", "[recording]"));
    }
    if (booleanField(record, "allowPrivacyChange") === true) {
      header.push(theme.fg("warning", "[privacy change]"));
    }
    component.addChild(new Text(header.join(" "), 0, 0));
    const safetyNote = stringField(record, "safetyNote");
    if (safetyNote !== undefined && safetyNote.trim() !== "") {
      component.addChild(
        new Text(
          theme.fg("muted", `note: ${clipInline(safetyNote, context.expanded ? 200 : 64)}`),
          0,
          0,
        ),
      );
    }
    return component;
  },

  renderResult(
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContext,
  ): Component {
    const component = resetContainer(context.lastComponent);
    const meta = extractMacuseMeta(result.details);
    if (meta !== undefined && booleanField(meta, "dispatched") === false) {
      component.addChild(new Spacer(1));
      component.addChild(new Text(theme.fg("error", "✗ refused (not dispatched)"), 0, 0));
    }
    renderFallbackBody(component, result, { options, theme, context, maxVisualLines: 5 });
    return component;
  },
});

export const renderersForTool = (name: string): ToolRenderers => {
  if (name === "macuse") {
    return macuseToolRenderers;
  }
  if (name === "macuse_reset") {
    return macuseResetToolRenderers;
  }
  return auxiliaryToolRenderers(name);
};
