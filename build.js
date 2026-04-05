const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

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
  loader: { '.json': 'json' },
}).then(() => {
  const presetSrc = path.join(__dirname, 'src', 'plugin', 'rslatte-workspace-preset.json');
  const presetOut = path.join(__dirname, 'rslatte-workspace-preset.json');
  fs.copyFileSync(presetSrc, presetOut);
  console.log('✅ Build completed successfully');
}).catch((error) => {
  console.error('❌ Build failed:', error);
  process.exit(1);
});
