export const UPSTREAM_TOOL_ARG_KEYS = Object.freeze({
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
	computer_history_update_settings: ["observation", "showMenuBarIcon"],
});

const HOST_ONLY_TOOL_ARG_KEYS = new Set([
	"element", "elementId", "element_id", "elementDescription", "element_description", "role", "elementRole", "name", "elementName", "targets",
	"expectedRole", "expectedName", "expectedDescription", "expectedId", "expectedValue", "approval", "allowMutating", "safetyNote", "allowPointer",
	"allowPointerClick", "allowPointerDrag", "allowRecording", "allowPrivacyChange", "requireStateChange", "includeImage", "saveImagePath", "detail",
	"targetScope", "maxTextChars", "toolTimeoutMs", "trackFocus", "runningOnly", "filter", "screenshotStep", "modifiers",
]);

export function pickUpstreamToolArgs(tool, args) {
	if (!Object.hasOwn(UPSTREAM_TOOL_ARG_KEYS, tool)) throw new Error(`Unsupported upstream Computer Use tool: ${tool}`);
	const keys = UPSTREAM_TOOL_ARG_KEYS[tool];
	const unknown = Object.keys(args).filter((key) => !keys.includes(key) && !HOST_ONLY_TOOL_ARG_KEYS.has(key));
	if (unknown.length) throw new Error(`Unsupported arguments for ${tool}: ${unknown.join(", ")}`);
	return Object.fromEntries(keys.filter((key) => Object.hasOwn(args, key)).map((key) => [key, args[key]]));
}
