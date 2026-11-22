/**
 * sync-drive-cdn.js
 * GitHub Actions Cloud Sync Agent: Google Drive FREE AUDIO -> Fastly Edge CDN
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const audioDir = path.resolve(__dirname, '../audio');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

const catalogUrl = 'https://script.google.com/macros/s/AKfycbzLHk2-SsGIXKgbRgHj9PYpCH9niiBTj08RlaBAk6Bt0ywygJUKtXec2POug46DR8H5/exec?api=free-audio-catalog';

function toAsciiFilename(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0111\u0110]/g, 'd')
    .replace(/[^a-zA-Z0-9.]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/_\./g, '.');
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
  const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
  return new Promise((resolve, reject) => {
    function getWithRedirect(u) {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return getWithRedirect(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} downloading fileId ${fileId}`));
        }
        const fileStream = fs.createWriteStream(dstPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close(resolve);
        });
        fileStream.on('error', reject);
      }).on('error', reject);
    }
    getWithRedirect(url);
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
        console.log(`✓ Downloaded "${track.name}" (${(fs.statSync(targetFile).size / 1024 / 1024).toFixed(2)} MB).`);
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
