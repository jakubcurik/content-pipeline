import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';

const commonOptions = {
  platform: 'node',
  target: 'node18',
  format: 'esm',
  bundle: true,
  minify: false,
  sourcemap: false,
  // Node ESM bundles often need createRequire for transitive CommonJS deps.
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
};

const cliBanner = {
  js: `#!/usr/bin/env node\n${commonOptions.banner.js}`,
};

/** MCP server bundles – GSC + GA4, each a standalone stdio subprocess, one shared Google OAuth. */
const servers = [
  { entry: 'src/gsc/index.ts', out: 'dist/google-gsc.js' },
  { entry: 'src/ga4/index.ts', out: 'dist/google-ga4.js' },
];

/** Stand-alone CLI: one-time Google OAuth refresh-token generator (GSC + GA4 scopes). */
const clis = [{ entry: 'src/oauth-google.ts', out: 'bin/google-oauth.js' }];

for (const { entry, out } of servers) {
  await build({ ...commonOptions, entryPoints: [entry], outfile: out });
}

for (const { entry, out } of clis) {
  await build({ ...commonOptions, entryPoints: [entry], outfile: out, banner: cliBanner });
  try {
    await chmod(out, 0o755);
  } catch {
    // ignore on systems where chmod is not applicable (Windows)
  }
}

console.log('Build complete:');
for (const { out } of servers) console.log(`  - ${out}`);
for (const { out } of clis) console.log(`  - ${out}`);
