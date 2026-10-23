// Module hooks for a Cloudflare Worker run in Node by @oodlc/oodle/workers (src/workers.ts).
// Plain JavaScript: Node runs hooks on their own thread, where tsx isn't registered.
//
// - `cloudflare:workers`, `cloudflare:email`, `cloudflare:sockets` and `cloudflare:workflows`
//   re-export the modules src/workers.ts keeps on globalThis[Symbol.for('oodle.workers')].
// - Files Wrangler bundles as modules load as it bundles them: Text as a string, Data as an
//   ArrayBuffer, CompiledWasm as a WebAssembly.Module. The extensions come from Wrangler's
//   defaults plus the project's `rules`.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

let kinds = { text: ['.txt', '.html', '.sql'], data: ['.bin'], wasm: ['.wasm'] };

export function initialize(data) {
  if (data?.kinds) kinds = data.kinds;
}

// The modules themselves live in src/workers.ts, on the main thread, so `require` sees the same ones.
const NAMES = {
  workers: ['env', 'WorkerEntrypoint', 'DurableObject', 'WorkflowEntrypoint', 'RpcTarget', 'waitUntil'],
  email: ['EmailMessage'],
  sockets: ['connect'],
  workflows: ['NonRetryableError'],
};

const moduleSource = (name) => {
  const m = `globalThis[Symbol.for('oodle.workers')].modules[${JSON.stringify(name)}]`;
  return `const m = ${m};\n${NAMES[name].map((n) => `export const ${n} = m.${n};`).join('\n')}\nexport default m;\n`;
};

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('cloudflare:')) return { url: `oodle-cf:${specifier.slice('cloudflare:'.length)}`, shortCircuit: true };
  if (specifier.endsWith('.wasm?module')) return nextResolve(specifier.slice(0, -'?module'.length), context);
  return nextResolve(specifier, context);
}

const kindOf = (url) => {
  if (!url.startsWith('file:')) return undefined;
  const path = url.split('?')[0];
  for (const [kind, exts] of Object.entries(kinds)) if (exts.some((e) => path.endsWith(e))) return kind;
  return undefined;
};

export async function load(url, context, nextLoad) {
  if (url.startsWith('oodle-cf:')) {
    const name = url.slice('oodle-cf:'.length);
    const source = NAMES[name] ? moduleSource(name) : `throw new Error('cloudflare:${name} is not simulated by Oodle');`;
    return { format: 'module', source, shortCircuit: true };
  }
  const kind = kindOf(url);
  if (!kind) return nextLoad(url, context);
  const bytes = await readFile(fileURLToPath(url.split('?')[0]));
  const b64 = JSON.stringify(bytes.toString('base64'));
  const decode = `Uint8Array.from(atob(${b64}), (c) => c.charCodeAt(0))`;
  const source = kind === 'text'
    ? `export default ${JSON.stringify(bytes.toString('utf8'))};`
    : kind === 'wasm'
      ? `export default new WebAssembly.Module(${decode});`
      : `export default ${decode}.buffer;`;
  return { format: 'module', source, shortCircuit: true };
}
