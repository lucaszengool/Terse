// Build script for Terse VS Code extension
// Run: node esbuild.js          (production)
// Run: node esbuild.js --watch  (development)

const esbuild = require('esbuild');
const isWatch = process.argv.includes('--watch');

const baseConfig = {
  entryPoints: ['src/extension.js'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: [
    'vscode',          // provided by VS Code runtime
    'nspell',          // contains native binary data (kept in node_modules)
    'dictionary-en',   // large Hunspell binary files (kept in node_modules)
  ],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !isWatch ? false : 'inline',
  minify: !isWatch,
  logLevel: 'info',
};

async function build() {
  if (isWatch) {
    const ctx = await esbuild.context(baseConfig);
    await ctx.watch();
    console.log('Watching for changes…');
  } else {
    await esbuild.build(baseConfig);
    console.log('Build complete → dist/extension.js');
  }
}

build().catch(e => { console.error(e); process.exit(1); });
