import { StringDecoder } from 'node:string_decoder';

export async function* readProofLines(input) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const split = function* () {
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line) > 131072) throw new Error('Proof input line exceeds 128 KiB.');
      if (line.trim()) yield line;
    }
    if (Buffer.byteLength(pending) > 131072) throw new Error('Proof input line exceeds 128 KiB.');
  };
  for await (const chunk of input) {
    pending += decoder.write(chunk);
    yield* split();
  }
  pending += decoder.end();
  yield* split();
  if (pending.trim()) yield pending;
}
