import { auxiliaryTools } from './auxiliary-runtime.mjs';

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = (description) => ({ type: 'string', minLength: 1, description });
const flag = (description) => ({ type: 'boolean', description });
const timeoutMs = { type: 'integer', minimum: 1000, maximum: 300000, description: 'Execution deadline in milliseconds; default 90000. Cancellation never undoes an application action.' };

export const primaryTools = [
  {
    name: 'macuse',
    description: 'Run JavaScript in the persistent native macOS Computer Use runtime. First call: await cua.getState() or var app = await cua.getApp("Exact App"); read the emitted API docs and state before acting. Await every action. For accessibility Press use app.performSecondaryAction(index, "Press"); primary Press may be absent from Sky\'s secondary-action list. app.click(index) is pointer input and still requires allowPointer:true. getAXState(), getScreenshot(), and getAXStateAndScreenshot() emit observations automatically. Keep programs short; use JavaScript conditions, loops and assertions. Text output is capped; full state remains available for guards.',
    inputSchema: schema({
      code: text('JavaScript using the installed cua API. Bindings persist until reset or a session boundary.'),
      apps: { type: 'array', items: text('Exact app identifier used by the program'), description: 'Allowed mutation targets; also scopes native focus-window observations.' },
      allowMutating: flag('Must be true for application actions, with a concrete safetyNote and a prior app observation.'),
      allowPointer: flag('Must be true for pointer clicks/drags. Prefer accessibility actions. Coordinates use the returned screenshot pixel space.'),
      safetyNote: { ...text('Approved app, intended effect, and stop boundary. Never authorizes unrelated sends, purchases, deletes, credentials or privacy changes.'), minLength: 20 },
      timeoutMs,
      saveImagePath: text('Save the first emitted screenshot to this path (relative to cwd; ~ supported). Never overwrites an existing file.'),
      trackFocus: flag('Observe native activation/window events; default true. Does not guarantee input isolation.'),
    }, ['code']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'macuse_insert_text',
    description: 'Insert Unicode text into the already-focused selection through native Accessibility, with identity/selection guards and exact readback. Requires a recent same-app macuse observation. No keyboard, clipboard, or fallback replay. Use app.setValue only when replacing the entire field is intended. Observe again after insertion.',
    inputSchema: schema({
      app: text('Exact identifier from the preceding macuse observation'),
      text: { type: 'string', description: 'Literal text replacing only the current selection' },
      allowMutating: flag('Must be true'),
      safetyNote: { ...text('Approved app, intended insertion, and stop boundary'), minLength: 20 },
      expectedTitle: { type: 'string', description: 'Exact expected window title' },
      expectedUrl: { type: 'string', description: 'Exact expected document URL' },
    }, ['app', 'text', 'allowMutating', 'safetyNote']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'macuse_reset',
    description: 'Reset the owned JavaScript kernel and app observations. Does not undo application actions or restart global Computer Use services. Never replay a dispatched or unknown-outcome mutation automatically.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

export const tools = [...primaryTools, ...auxiliaryTools];
