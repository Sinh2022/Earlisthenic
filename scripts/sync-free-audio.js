/**
 * sync-free-audio.js
 * Automated Server-Side Sync Engine: Google Drive FREE AUDIO -> GitHub Pages Fastly Edge CDN
 *
 * Runs locally or in CI/CD (GitHub Actions):
 * 1. Scans `FREE AUDIO/` for any new studio audio tracks (.flac, .wav).
 * 2. Normalizes filenames into URL-safe ASCII for universal cross-platform CDN streaming.
 * 3. Copies new audio tracks into `earlisthenic-gh-pages/audio/`.
 * 4. Updates `.earlisthenic-catalog.json` with exact byte sizes, MIME types, and dual CDN endpoints.
 * 5. Automatically commits and pushes to GitHub Pages CDN so new files become available globally within seconds.
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const freeAudioDir = path.join(rootDir, 'FREE AUDIO');
const ghRepoDir = path.resolve(rootDir, '../earlisthenic-gh-pages');
const cdnAudioDir = path.join(ghRepoDir, 'audio');
const catalogPath = path.join(freeAudioDir, '.earlisthenic-catalog.json');

if (!fs.existsSync(cdnAudioDir)) {
  fs.mkdirSync(cdnAudioDir, { recursive: true });
}

function toAsciiFilename(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0110]/g, 'D')
    .replace(/[\u0111]/g, 'd')
    .replace(/[^a-zA-Z0-9.]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/_\./g, '.');
}

function sanitizeFlacFileInPlace(filePath) {
  if (!filePath.endsWith('.flac') || !fs.existsSync(filePath)) return;
  const buf = fs.readFileSync(filePath);
  if (buf.length < 42 || buf.toString('ascii', 0, 4) !== 'fLaC') return;

  const chunks = [buf.subarray(0, 4)];
  let offset = 4;
  let isLast = false;
  const blocks = [];

  while (offset < buf.length && !isLast) {
    const headerByte = buf[offset];
    isLast = (headerByte & 0x80) !== 0;
    const type = headerByte & 0x7F;
    const len = (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    const blockEnd = offset + 4 + len;
    if (blockEnd > buf.length) return;
    if (type !== 6 && type !== 1) { // Strip PICTURE (6) and PADDING (1)
      blocks.push({ type, data: buf.subarray(offset + 4, blockEnd) });
    }
    offset = blockEnd;
  }
  if (blocks.length === 0 || blocks[0].type !== 0) return;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const isL = (i === blocks.length - 1);
    const header = Buffer.alloc(4);
    header[0] = (isL ? 0x80 : 0x00) | (b.type & 0x7F);
    header[1] = (b.data.length >> 16) & 0xFF;
    header[2] = (b.data.length >> 8) & 0xFF;
    header[3] = b.data.length & 0xFF;
    chunks.push(header);
    chunks.push(b.data);
  }
  chunks.push(buf.subarray(offset));
  const cleaned = Buffer.concat(chunks);
  if (cleaned.length < buf.length) {
    fs.writeFileSync(filePath, cleaned);
    console.log(`[sanitize] Cleaned metadata from ${path.basename(filePath)} (saved ${(buf.length - cleaned.length) / 1024} KB)`);
  }
}

console.log('=== Earlisthenic FREE AUDIO -> Edge CDN Sync Engine ===');
console.log('Scanning source directory:', freeAudioDir);

const supportedExts = ['.flac', '.wav', '.mp3', '.m4a'];
const files = fs.readdirSync(freeAudioDir).filter(f => supportedExts.includes(path.extname(f).toLowerCase()));

console.log(`Found ${files.length} audio tracks in FREE AUDIO directory.`);

let catalog = [];
if (fs.existsSync(catalogPath)) {
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (e) {
    catalog = [];
  }
}

let addedCount = 0;

files.forEach(file => {
  const srcPath = path.join(freeAudioDir, file);
  const stat = fs.statSync(srcPath);
  const asciiName = toAsciiFilename(file);
  const dstPath = path.join(cdnAudioDir, asciiName);

  let needsCopy = !fs.existsSync(dstPath);
  if (!needsCopy) {
    const dstStat = fs.statSync(dstPath);
    if (dstStat.size !== stat.size) needsCopy = true;
  }

  if (needsCopy) {
    console.log(`-> Syncing: "${file}" (${(stat.size / 1024 / 1024).toFixed(2)} MB) -> ${asciiName}`);
    fs.copyFileSync(srcPath, dstPath);
    sanitizeFlacFileInPlace(dstPath);
    addedCount++;
  }

  // Update or append catalog entry
  let entry = catalog.find(t => t.name === file);
  if (!entry) {
    entry = {
      fileId: 'local_' + Buffer.from(file).toString('hex').slice(0, 16),
      name: file,
      sizeBytes: stat.size,
      mimeType: file.endsWith('.flac') ? 'audio/flac' : 'audio/wav',
      extension: path.extname(file).toLowerCase(),
      updatedAt: new Date(stat.mtimeMs).toISOString()
    };
    catalog.push(entry);
  } else {
    entry.sizeBytes = stat.size;
    entry.updatedAt = new Date(stat.mtimeMs).toISOString();
  }

  entry.cdnUrl = 'https://sinh2022.github.io/Earlisthenic/audio/' + asciiName;
  entry.fallbackCdnUrl = 'https://raw.githubusercontent.com/Sinh2022/Earlisthenic/main/audio/' + asciiName;
});

// Write updated catalog to both source and CDN distribution
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), 'utf8');
fs.writeFileSync(path.join(cdnAudioDir, 'earlisthenic-catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');
console.log('✓ Updated catalog files.');

if (addedCount > 0) {
  console.log(`Pushing ${addedCount} new/updated audio assets to GitHub Edge CDN...`);
  try {
    cp.execSync('git add audio/ .nojekyll', { cwd: ghRepoDir });
    cp.execSync(`git commit -m "feat(audio): sync ${addedCount} new/updated audio assets from FREE AUDIO"`, { cwd: ghRepoDir });
    cp.execSync('git push origin main', { cwd: ghRepoDir, stdio: 'inherit' });
    console.log('✓ Successfully deployed new audio tracks to Fastly Global Edge CDN!');
  } catch (err) {
    console.error('Git push failed or nothing to commit:', err.message);
  }
} else {
  console.log('✓ Edge CDN audio assets are already 100% up to date.');
}
