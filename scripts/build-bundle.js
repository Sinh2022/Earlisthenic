/**
 * build-bundle.js (Edge CDN distribution compiler)
 * Compiles and bundles client-side scripts into:
 * `I:\My Drive\earlisthenic-gh-pages\dist\earlisthenic-core.js`
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.resolve(__dirname, '..');
const sourceCandidates = [
  rootDir,
  path.resolve(rootDir, '../Earlisthenic')
];

let sourceDir = sourceCandidates.find(dir => fs.existsSync(path.join(dir, 'AudioEngine.html')) && fs.existsSync(path.join(dir, 'Games.html')));
if (!sourceDir) {
  console.warn('⚠️ Source HTML partials not found in local workspace. Keeping existing compiled dist/earlisthenic-core.js.');
  process.exit(0);
}

const outDir = path.join(rootDir, 'dist');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const scriptOrder = [
  'AudioEngine.html',
  'AudioSources.html',
  'Games.html',
  'MockTests.html',
  'Analytics.html',
  'ClientApp.html'
];

let bundle = '/* Earlisthenic High-Performance Core Engine Bundle v2.12.3 */\n';

for (const file of scriptOrder) {
  const filePath = path.join(sourceDir, file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing expected source file: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const js = raw
    .replace(/^[\s\S]*?<script(?:\s+[^>]*)?>/i, '')
    .replace(/<\/script>[\s\S]*?$/i, '');
  
  bundle += `\n/* ==================== [MODULE: ${file}] ==================== */\n`;
  bundle += js + '\n';
}

// Verify bundle syntax
try {
  new vm.Script(bundle, { filename: 'earlisthenic-core.js' });
  console.log('✓ Syntax verification passed: Bundle compiles without errors in Node VM.');
} catch (err) {
  console.error('✗ Syntax verification failed for bundle:', err);
  process.exit(1);
}

const outPath = path.join(outDir, 'earlisthenic-core.js');
fs.writeFileSync(outPath, bundle, 'utf8');
console.log(`✓ Built bundle: ${outPath} (${(bundle.length / 1024).toFixed(1)} KB)`);
