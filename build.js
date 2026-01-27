const esbuild = require('esbuild');

const isProduction = process.env.NODE_ENV === 'production';

esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  outfile: 'main.js',
  external: ['obsidian'],
  platform: 'node',
  target: 'ES2020',
  minify: isProduction,
  sourcemap: !isProduction,
  treeShaking: true,
}).then(() => {
  console.log('✅ Build completed successfully');
}).catch((error) => {
  console.error('❌ Build failed:', error);
  process.exit(1);
});
