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

export function pickUpstreamToolArgs(tool, args) {
	const keys = UPSTREAM_TOOL_ARG_KEYS[tool];
	if (!keys) throw new Error(`Unsupported upstream Computer Use tool: ${tool}`);
	return Object.fromEntries(keys.filter((key) => Object.hasOwn(args, key)).map((key) => [key, args[key]]));
}
