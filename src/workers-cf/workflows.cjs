// cloudflare:workflows for code loaded through require. See src/workers.ts.
module.exports = globalThis[Symbol.for('oodle.workers')].modules.workflows;
