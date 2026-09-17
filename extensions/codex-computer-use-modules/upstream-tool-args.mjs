const upstreamToolArgKeys = {
	list_apps: [],
	get_app_state: ["app"],
	click: ["app", "click_count", "element_index", "mouse_button", "x", "y"],
	perform_secondary_action: ["app", "element_index", "action"],
	set_value: ["app", "element_index", "value"],
	select_text: ["app", "element_index", "text", "prefix", "suffix", "selection"],
	scroll: ["app", "element_index", "direction", "pages"],
	drag: ["app", "from_x", "from_y", "to_x", "to_y"],
	press_key: ["app", "key"],
	type_text: ["app", "text"],
	event_stream_start: [],
	event_stream_status: [],
	event_stream_stop: [],
	computer_history_pause: [],
	computer_history_resume: [],
	computer_history_status: [],
	computer_history_get_settings: [],
	computer_history_update_settings: ["observation"],
};
for (const keys of Object.values(upstreamToolArgKeys)) Object.freeze(keys);
export const UPSTREAM_TOOL_ARG_KEYS = Object.freeze(upstreamToolArgKeys);

export const HOST_ONLY_TOOL_ARG_KEYS = Object.freeze([
	"element", "elementId", "element_id", "elementDescription", "element_description", "role", "elementRole", "name", "elementName", "targets",
	"expectedRole", "expectedName", "expectedDescription", "expectedId", "expectedValue", "expectedTitle", "expectedUrl", "approval", "allowMutating", "safetyNote", "allowPointer",
	"allowPointerClick", "allowPointerDrag", "allowRecording", "allowPrivacyChange", "requireStateChange", "includeImage", "saveImagePath", "detail",
	"targetScope", "maxTextChars", "toolTimeoutMs", "trackFocus", "runningOnly", "filter", "screenshotStep", "modifiers",
]);
const hostOnlyToolArgKeySet = new Set(HOST_ONLY_TOOL_ARG_KEYS);
const targetKeys = ["element", "element_index", "elementId", "element_id", "elementDescription", "element_description", "role", "elementRole", "name", "elementName"];

export function validateToolArguments(tool, args) {
	if (!Object.hasOwn(UPSTREAM_TOOL_ARG_KEYS, tool)) throw new Error(`Unsupported upstream Computer Use tool: ${tool}`);
	const required = {
		get_app_state: ["app"], click: ["app"], drag: ["app", "from_x", "from_y", "to_x", "to_y"],
		perform_secondary_action: ["app", "action"], set_value: ["app", "value"],
		select_text: ["app", "text"], scroll: ["app", "direction"], press_key: ["app", "key"], type_text: ["app", "text"],
	};
	for (const key of required[tool] ?? []) {
		if (args[key] === undefined) throw new Error(`${tool} requires arguments.${key}.`);
	}
	for (const key of ["app", "action", "value", "text", "key", "prefix", "suffix", "elementId", "element_id", "elementDescription", "element_description", "role", "elementRole", "name", "elementName", "expectedRole", "expectedName", "expectedDescription", "expectedId", "expectedValue", "expectedTitle", "expectedUrl"]) {
		if (args[key] !== undefined && typeof args[key] !== "string") throw new Error(`${tool} arguments.${key} must be a string.`);
	}
	if (args.app !== undefined && !args.app.trim()) throw new Error(`${tool} requires a non-empty app.`);
	for (const key of ["x", "y", "from_x", "from_y", "to_x", "to_y", "pages", "click_count"]) {
		if (args[key] !== undefined && (typeof args[key] !== "number" || !Number.isFinite(args[key]))) throw new Error(`${tool} arguments.${key} must be a finite number.`);
	}
	for (const key of ["element", "element_index"]) {
		if (args[key] !== undefined && typeof args[key] !== "string" && !(typeof args[key] === "number" && Number.isFinite(args[key]))) throw new Error(`${tool} arguments.${key} must be a string or finite number.`);
	}
	for (const [key, values] of Object.entries({ direction: ["up", "down", "left", "right"], selection: ["text", "cursor_before", "cursor_after"], mouse_button: ["left", "right", "middle"] })) {
		if (args[key] !== undefined && !values.includes(args[key])) throw new Error(`${tool} arguments.${key} must be one of ${values.join(", ")}.`);
	}
	if (args.modifiers !== undefined && (!Array.isArray(args.modifiers) || !args.modifiers.every((item) => typeof item === "string"))) throw new Error(`${tool} arguments.modifiers must be an array of strings.`);
	if (args.targets !== undefined && (!Array.isArray(args.targets) || !args.targets.length || !args.targets.every((target) => target && typeof target === "object" && !Array.isArray(target)))) throw new Error(`${tool} arguments.targets must be a non-empty array of target objects.`);
	for (const target of args.targets ?? []) {
		if (!targetKeys.some((key) => target[key] !== undefined) || Object.keys(target).some((key) => !targetKeys.includes(key))) throw new Error(`${tool} arguments.targets entries must contain only element selectors and at least one selector.`);
		validateToolArguments("get_app_state", { app: args.app, ...target });
	}
	const hasTarget = args.targets !== undefined || targetKeys.some((key) => args[key] !== undefined);
	if (["set_value", "perform_secondary_action"].includes(tool) && !hasTarget) throw new Error(`${tool} requires an element target.`);
	if (tool === "click" && !hasTarget && !(typeof args.x === "number" && typeof args.y === "number")) throw new Error("click requires an element target or both x and y.");
}

export function pickUpstreamToolArgs(tool, args) {
	if (!Object.hasOwn(UPSTREAM_TOOL_ARG_KEYS, tool)) throw new Error(`Unsupported upstream Computer Use tool: ${tool}`);
	const keys = UPSTREAM_TOOL_ARG_KEYS[tool];
	const unknown = Object.keys(args).filter((key) => !keys.includes(key) && !hostOnlyToolArgKeySet.has(key));
	if (unknown.length) throw new Error(`Unsupported arguments for ${tool}: ${unknown.join(", ")}`);
	return Object.fromEntries(keys.filter((key) => Object.hasOwn(args, key)).map((key) => [key, args[key]]));
}
