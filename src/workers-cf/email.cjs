// cloudflare:email for code loaded through require. See src/workers.ts.
module.exports = globalThis[Symbol.for('oodle.workers')].modules.email;
