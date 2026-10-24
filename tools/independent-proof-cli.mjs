#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { IndependentProofSession } from '../lib/independent-proof-session.mjs';
import { callIndependentProof, independentProofTools } from '../lib/independent-proof-tools.mjs';
import { readProofLines } from '../lib/independent-proof-jsonl.mjs';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean', short: 'h' }, pretty: { type: 'boolean' } } });
  const [command = 'help', tool = 'macuse_independent_proof', json = '{}'] = positionals;
  if (values.help || command === 'help') {
    console.log('Opt-in independent fixture proof. Production macuse is unchanged.\nUsage: node tools/independent-proof-cli.mjs tools | call <tool> <JSON> | session\nOperator target: MACUSE_INDEPENDENT_PROOF_TARGET JSON. Without a target only pure JavaScript is available.\nSession input: one {"tool":"macuse_independent_proof","input":{"code":"var retained=41; retained"}} per LF-delimited line. No automatic replay.');
    return;
  }
  const print = value => process.stdout.write(`${JSON.stringify(value, null, values.pretty ? 2 : 0)}\n`);
  if (command === 'tools') { print(independentProofTools); return; }
  if (!['call', 'session'].includes(command)) throw new Error(`Unknown proof command: ${command}`);
  const session = new IndependentProofSession();
  const controller = new AbortController();
  const cancel = () => { controller.abort(); process.stdin.destroy(); };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const call = async (name, input) => {
    const result = await callIndependentProof(session, name, input, { signal: controller.signal });
    print(result);
    if (result.isError) process.exitCode = 1;
  };
  try {
    if (command === 'call') await call(tool, JSON.parse(json));
    else {
      if (values.pretty) throw new Error('session does not accept --pretty; output is JSONL.');
      for await (const line of readProofLines(process.stdin)) {
        const request = JSON.parse(line);
        await call(request.tool, request.input);
        if (controller.signal.aborted) break;
      }
    }
  } finally {
    const stopped = await session.stop();
    if (!stopped.settled || !stopped.workerStopped || !stopped.nativeStopped) {
      console.error('Independent proof shutdown is unsettled; do not infer GUI cancellation or replay actions.');
      process.exitCode = 1;
    }
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
main().catch(error => { console.error(`Independent proof: ${error.message}`); process.exitCode = 1; });
