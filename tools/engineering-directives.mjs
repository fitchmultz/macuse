import { parseSync } from "oxc-parser";

/** @typedef {{ path: string, rule: string, id: string, owner: string, conditions: string[], operation: string }} DirectiveSite */
/** @typedef {Record<string, unknown> & {start: number, end: number, type: string}} SyntaxNode */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is SyntaxNode} */
function isNode(value) {
  return (
    isRecord(value) &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    typeof value.type === "string"
  );
}

/** @param {unknown} value @param {number} position @param {SyntaxNode[]} nodes */
function collectEnclosing(value, position, nodes) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEnclosing(item, position, nodes);
    }
    return;
  }
  if (!isNode(value) || value.start > position || value.end < position) {
    return;
  }
  nodes.push(value);
  for (const child of Object.values(value)) {
    collectEnclosing(child, position, nodes);
  }
}

/** @param {string} source @param {unknown} node */
function nodeText(source, node) {
  return isNode(node) ? source.slice(node.start, node.end) : "";
}

/** @param {SyntaxNode} node */
function isRegistration(node) {
  return (
    node.type === "CallExpression" &&
    isRecord(node.callee) &&
    node.callee.type === "Identifier" &&
    node.callee.name === "nodeTest"
  );
}

/** @param {string} source @param {SyntaxNode[]} nodes */
function directiveOwner(source, nodes) {
  const test = nodes.findLast(isRegistration);
  if (test !== undefined && Array.isArray(test.arguments)) {
    return nodeText(source, test.arguments[0]);
  }
  const fn = nodes.findLast(
    (node) => node.type === "MethodDefinition" || node.type === "FunctionDeclaration",
  );
  if (fn === undefined) {
    return "module";
  }
  const key = isRecord(fn.key) ? fn.key : fn.id;
  return isRecord(key) && typeof key.name === "string" ? key.name : "module";
}

/** @param {string} path @param {string} source @param {import("oxc-parser").Comment} comment @param {SyntaxNode[]} nodes @returns {DirectiveSite} */
function siteFromComment(path, source, comment, nodes) {
  const match = /^\s*oxlint-disable-next-line\s+(\S+)\s+--\s+(QX-\d{3}):\s+\S/.exec(comment.value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`${path}: unrecorded or malformed directive`);
  }
  const conditions = nodes
    .filter((node) => node.type === "IfStatement")
    .map((node) => nodeText(source, node.test).replace(/\s+/g, " "));
  const operation = source.slice(comment.end).split("\n")[1]?.trim() ?? "";
  return {
    path,
    rule: match[1],
    id: match[2],
    owner: directiveOwner(source, nodes),
    conditions,
    operation,
  };
}

/** Parse real comments, not strings or documentation examples. @param {string} path @param {string} source @returns {DirectiveSite[]} */
export function directiveSites(path, source) {
  const { program, comments, errors } = parseSync(path, source);
  if (errors.length !== 0) {
    throw new Error(`${path}: ${errors[0]?.message ?? "parse error"}`);
  }
  /** @type {DirectiveSite[]} */
  const sites = [];
  for (const comment of comments) {
    if (
      !/^\s*(?:oxlint|eslint)-(?:disable|enable)|^\s*@ts-(?:ignore|nocheck|expect-error)/.test(
        comment.value,
      )
    ) {
      continue;
    }
    if (comment.type !== "Line" || !/^\s*oxlint-disable-next-line\b/.test(comment.value)) {
      throw new Error(`${path}: unsupported directive`);
    }
    /** @type {SyntaxNode[]} */
    const nodes = [];
    collectEnclosing(program, comment.start, nodes);
    sites.push(siteFromComment(path, source, comment, nodes));
  }
  return sites;
}

/** @param {unknown} value @param {boolean} insideTest @param {number[]} positions */
function collectNestedRegistrations(value, insideTest, positions) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedRegistrations(item, insideTest, positions);
    }
    return;
  }
  if (!isNode(value)) {
    return;
  }
  const registration = isRegistration(value);
  if (registration && insideTest) {
    positions.push(value.start);
  }
  for (const child of Object.values(value)) {
    collectNestedRegistrations(child, insideTest || registration, positions);
  }
}

/** @param {string} path @param {string} source @returns {number[]} */
export function nestedRegistrations(path, source) {
  const parsed = parseSync(path, source);
  if (parsed.errors.length > 0) {
    throw new Error(`${path}: could not parse test registrations`);
  }
  /** @type {number[]} */
  const positions = [];
  collectNestedRegistrations(parsed.program, false, positions);
  return positions;
}
