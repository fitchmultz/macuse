import { nativeTextUnavailableReason } from "../tools/macos-native.mjs";
import { findSameElement, sameDocument } from './app-state.mjs';

// The parent serializes this entire preflight/edit/readback with its other GUI operations.
export async function insertText(native, input, observation, { signal, refreshObservation } = {}) {
	const details = { tool: "insert_text", app: input?.app, dispatched: false, outcome: "not_dispatched" };
	let observationId;
	let requestPending = false;
	let message;
	try {
		if (typeof input?.app !== "string" || !input.app.trim()) throw new Error("An exact running app name, bundle ID or path is required.");
		if (input.allowMutating !== true || typeof input.safetyNote !== "string" || input.safetyNote.trim().length < 20) {
			throw new Error("insert_text requires allowMutating:true and a safetyNote of at least 20 characters naming the target, intended effect and stop boundary. These flags do not supply user permission.");
		}
		if (typeof input.text !== "string" || !input.text.isWellFormed()) throw new Error("Text must be a well-formed Unicode string (no lone surrogates).");
		for (const key of ["expectedTitle", "expectedUrl"]) if (input[key] !== undefined && typeof input[key] !== "string") throw new Error(`${key} must be an exact string.`);
		if (!observation || typeof observation.app !== "string" || !Number.isFinite(observation.observedAt)) throw new Error("Observe the intended app and document before inserting text.");
		if (!observation.focused || typeof observation.focused.role !== "string" || typeof observation.focused.index !== "string") throw new Error("The previous observation did not identify a focused field. Get a fresh full getAXState before inserting text; use setValue only for intended full-field replacement.");
		signal?.throwIfAborted();
		const app = await native.resolveApp(input.app, { signal });
		if (![input.app, app.bundleId, app.path, app.name].includes(observation.app)) throw new Error("The previous observation belongs to another app. Observe the exact intended app before inserting text.");
		details.target = app;
		const focused = observation.focused;
		// CUA's display name can fall back to the ID or role; those are not AX labels.
		const name = focused.name !== focused.id && focused.name !== focused.role ? focused.name : undefined;
		if ((!focused.id && !name) || !findSameElement(focused, observation)) throw new Error('The observed focused field has no unique cross-source identity. Inspect an identifiable field; no edit was dispatched.');
		try { observationId = (await native.beginObservation([app.pid], { signal })).id; }
		catch (error) { details.focus = { observationAvailable: false, observationError: String(error?.message ?? error), inputAttribution: false }; }
		signal?.throwIfAborted();
		const fresh = await refreshObservation();
		if (!fresh || !sameDocument(observation, fresh)) throw new Error("The app document changed since the last observation. Observe the intended document again.");
		const target = findSameElement(focused, fresh);
		if (!target || target.cellValueContext !== focused.cellValueContext || target.descendants !== focused.descendants
			|| target.index !== fresh.focused?.index || target.name !== focused.name || target.value !== focused.value || target.disabled) {
			throw new Error("Focused field changed or is unavailable. Observe and verify the intended field before inserting text.");
		}
		signal?.throwIfAborted();
		const state = await native.inspectApp(app.pid, { signal });
		if (state.accessibilityTrusted !== true || !state.focusedWindow || !state.focusedElement?.selectedTextSettable) throw new Error(nativeTextUnavailableReason(state));
		if (state.pid !== app.pid || !state.app || state.app.bundleId !== app.bundleId || state.app.path !== app.path) throw new Error("The running app identity changed before insertion.");
		const window = state.focusedWindow;
		if (input.expectedTitle !== undefined && window.title !== input.expectedTitle) throw new Error("Window guard failed: expectedTitle does not match the focused window.");
		if (input.expectedUrl !== undefined && window.document !== input.expectedUrl) throw new Error("Document guard failed: expectedUrl does not match the focused document.");
		const sameNativeDocument = observation.url ? observation.url === window.document
			: observation.title != null && observation.title === window.title;
		if (!sameNativeDocument) throw new Error("The focused window/document changed since the last observation. Observe the intended document again.");
		const field = state.focusedElement;
		const role = field.roleDescription?.toLowerCase().replace(/^search text field$/, "search");
		if ((focused.id !== undefined && focused.id !== field.identifier)
			|| ![field.role, role].includes(focused.role)
			|| (name && ![field.title, field.description].includes(name))
			|| (focused.value !== undefined && focused.value !== field.value)) {
			throw new Error("The focused field or its value changed since the last observation. Observe the intended field again.");
		}
		signal?.throwIfAborted();
		details.dispatched = true;
		details.outcome = "unknown";
		requestPending = true;
		const edit = await native.replaceSelectedText({ pid: app.pid, text: input.text,
			expected: { windowToken: window.token, windowTitle: window.title, document: window.document, elementToken: field.token, value: field.value } }, { signal });
		requestPending = false;
		details.dispatched = edit.mutationAttempted;
		details.outcome = edit.mutationAttempted ? "unknown" : "not_dispatched";
		if (edit.status !== "applied" || edit.verified !== true || edit.mutationAttempted !== true) throw new Error(edit.reason ?? "Native insertion did not return verified readback.");
		details.outcome = "verified";
		details.insertedUTF16Length = edit.insertedUTF16Length;
		details.replacedUTF16Length = edit.replacedUTF16Length;
		message = "Selected text replaced and verified on the edited field. No keyboard events or clipboard writes were used.";
	} catch (error) {
		if (error?.dispatched === false) { details.dispatched = false; details.outcome = "not_dispatched"; }
		if (requestPending) {
			await native.stop();
			observationId = undefined;
			details.focus = { observationAvailable: false, observationError: "Native helper settled after an uncertain edit; focus observation is unavailable.", inputAttribution: false };
		}
		message = `${details.dispatched ? "An edit was dispatched, but its outcome is unknown. Do not replay; inspect the intended field." : "No edit was dispatched."} ${String(error?.message ?? error)}`;
	} finally {
		if (observationId) {
			try { details.focus = { observationAvailable: true, ...await native.endObservation(observationId) }; }
			catch (error) { details.focus = { observationAvailable: false, observationError: String(error?.message ?? error), inputAttribution: false }; }
		}
	}
	return { content: [{ type: "text", text: message }], isError: details.outcome !== "verified", details: { macuse: details } };
}
