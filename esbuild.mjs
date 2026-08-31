import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// Golden rule: fast + lightweight.
// - The extension itself bundles to one small minified file.
// - Database drivers (pg, mssql) stay external and are require()d lazily,
//   only at the moment the user connects — activation stays near-instant.
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode', 'pg', 'pg-native', 'mssql'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
