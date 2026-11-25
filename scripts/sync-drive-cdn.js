/**
 * sync-drive-cdn.js
 * GitHub Actions Cloud Sync Agent: Google Drive FREE AUDIO -> Fastly Edge CDN
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const audioDir = path.resolve(__dirname, '../audio');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

function resolveGasCatalogUrl() {
  const fallbackBase = 'https://script.google.com/macros/s/AKfycbw0SvX7-njNLUQc7n3cnxQw-2XRa0oT0UfyCPM362jUfhKhDn1j6zEWcOZkkJ12ZfOO/exec';
  try {
    const indexPath = path.resolve(__dirname, '../index.html');
    if (fs.existsSync(indexPath)) {
      const html = fs.readFileSync(indexPath, 'utf8');
      const m = html.match(/gasBaseUrl\s*=\s*"([^"]+)"/);
      if (m && m[1]) return `${m[1]}?api=free-audio-catalog`;
    }
  } catch (e) {}
  return `${fallbackBase}?api=free-audio-catalog`;
}
const catalogUrl = resolveGasCatalogUrl();

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

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse JSON response: ' + data.slice(0, 200)));
        }
      });
    }).on('error', reject);
  });
}

function downloadFile(fileId, dstPath) {
  // Support large Google Drive files with virus warning bypass
  const initialUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
  return new Promise((resolve, reject) => {
    let cookies = [];
    function getWithRedirect(u) {
      const parsed = new URL(u);
      const opts = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      };
      if (cookies.length) opts.headers['Cookie'] = cookies.join('; ');

      https.get(opts, (res) => {
        if (res.headers['set-cookie']) {
          const sc = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']];
          sc.forEach(c => cookies.push(c.split(';')[0]));
        }

        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = res.headers.location.startsWith('http') ? res.headers.location : `https://${parsed.hostname}${res.headers.location}`;
          return getWithRedirect(nextUrl);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} downloading fileId ${fileId}`));
        }

        const contentType = res.headers['content-type'] || '';
        // If Google Drive returns HTML, it is a virus scan confirmation or sign-in gate
        if (contentType.includes('text/html')) {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => {
            const confirmMatch = body.match(/href="(\/uc\?export=download[^"]+)"/) || body.match(/action="([^"]+)"/);
            if (confirmMatch) {
              const confirmPath = confirmMatch[1].replace(/&amp;/g, '&');
              const nextU = confirmPath.startsWith('http') ? confirmPath : `https://drive.google.com${confirmPath}`;
              return getWithRedirect(nextU);
            }
            reject(new Error(`Google Drive returned HTML confirmation page for fileId ${fileId}`));
          });
          return;
        }

        const fileStream = fs.createWriteStream(dstPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close(() => {
            try {
              const fd = fs.openSync(dstPath, 'r');
              const magic = Buffer.alloc(4);
              fs.readSync(fd, magic, 0, 4, 0);
              fs.closeSync(fd);
              if (magic.toString('ascii') !== 'fLaC') {
                fs.unlinkSync(dstPath);
                return reject(new Error(`Downloaded file for ${fileId} is not a valid FLAC (magic: ${magic.toString('utf8')})`));
              }
            } catch (e) {
              return reject(e);
            }
            resolve();
          });
        });
        fileStream.on('error', reject);
      }).on('error', reject);
    }
    getWithRedirect(initialUrl);
  });
}

async function run() {
  console.log('Fetching Google Drive FREE AUDIO catalog from Apps Script...');
  const res = await fetchJson(catalogUrl);
  if (!res || !res.ok || !Array.isArray(res.tracks)) {
    console.log('No tracks found or error in catalog response:', res);
    return;
  }

  console.log(`Discovered ${res.tracks.length} tracks on Google Drive.`);
  let newCount = 0;

  for (const track of res.tracks) {
    if (!track.name || !track.fileId) continue;
    const ascii = toAsciiFilename(track.name);
    const targetFile = path.join(audioDir, ascii);

    let needsDownload = !fs.existsSync(targetFile);
    if (!needsDownload && track.sizeBytes) {
      const curSize = fs.statSync(targetFile).size;
      if (Math.abs(curSize - track.sizeBytes) > 1024) needsDownload = true;
    }

    if (needsDownload) {
      console.log(`Downloading new track: "${track.name}" (${track.fileId}) -> ${ascii}...`);
      try {
        await downloadFile(track.fileId, targetFile);
        sanitizeFlacFileInPlace(targetFile);
        console.log(`✓ Downloaded & sanitized "${track.name}" (${(fs.statSync(targetFile).size / 1024 / 1024).toFixed(2)} MB).`);
        newCount++;
      } catch (err) {
        console.error(`Failed to download "${track.name}":`, err.message);
      }
    }
  }

  // Update catalog in audio/
  const catalogPath = path.join(audioDir, 'earlisthenic-catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify(res.tracks, null, 2), 'utf8');
  console.log(`Sync process finished. ${newCount} new tracks acquired.`);
}

run().catch(err => {
  console.error('Fatal sync error:', err.message);
  process.exit(1);
});
