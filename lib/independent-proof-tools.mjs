export const independentProofTools = [
  {
    name: 'macuse_independent_proof',
    description: 'Run experimental persistent sandboxed JavaScript against only an operator-pinned disposable native fixture. Not the production backend or full macuse independence.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['code'],
      properties: {
        code: { type: 'string', minLength: 1, description: 'JavaScriptCore script or expression. Promise expressions are supported; top-level await and the vendor cua API are not.' },
        apps: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 1, uniqueItems: true },
        allowMutating: { type: 'boolean' },
        safetyNote: { type: 'string', minLength: 1 },
        timeoutMs: { type: 'integer', minimum: 50, maximum: 30000 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'macuse_independent_proof_reset',
    description: 'Stop the experimental execution/native workers and clear bindings. Does not undo GUI effects or erase prior unknown outcomes.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

export function independentProofFailure(error, { notDispatched = false } = {}) {
  return { content: [{ type: 'text', text: `Independent proof failed: ${error?.message ?? error}. Inspect fresh fixture state; never replay a dispatched or unknown action.` }],
    isError: true, details: { independent: { isError: true, outcome: notDispatched ? 'not-dispatched' : 'unknown',
      ...(notDispatched ? { dispatched: false } : {}), transportError: true } } };
}

export async function callIndependentProof(session, name, input, options = {}) {
  if (!independentProofTools.some(tool => tool.name === name)) return independentProofFailure(new Error(`Unknown independent proof tool: ${name}`), { notDispatched: true });
  if (name === 'macuse_independent_proof_reset' && (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)) {
    return independentProofFailure(new Error('Proof reset requires an empty object.'), { notDispatched: true });
  }
  try {
    if (name === 'macuse_independent_proof') return await session.execute(input, options);
    return await session.reset();
  } catch (error) { return independentProofFailure(error); }
}
