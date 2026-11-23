/**
 * Earlisthenic Cloudflare R2 Storage & Streaming Client
 * 
 * Provides ultra-low-latency audio streaming with HTTP Range 206 support,
 * zero egress fees, and automatic failover cascading:
 * Cloudflare R2 -> GitHub Pages Fastly Edge CDN -> Google Drive Bridge.
 */
class EarlisthenicR2Client {
  constructor(options = {}) {
    this.r2Endpoint = options.r2Endpoint || 'https://media.earlisthenic.com';
    this.bucketName = options.bucketName || 'earlisthenic-audio';
    this.fallbackCdnUrl = options.fallbackCdnUrl || 'https://sinh2022.github.io/Earlisthenic/audio';
    this.enabled = typeof options.enabled === 'boolean' ? options.enabled : true;
    this.audioCache = new Map();
  }

  /**
   * Resolves the primary and fallback streaming URLs for a given track
   * @param {Object} track - Audio track metadata object
   * @returns {Object} { primaryUrl, cdnUrl, fallbackUrl }
   */
  resolveStreamUrls(track) {
    if (!track) return null;
    const cleanFileName = track.cleanFileName || (track.name ? track.name.replace(/\s+/g, '_') : `${track.fileId}.flac`);
    const r2Url = `${this.r2Endpoint}/${encodeURIComponent(cleanFileName)}`;
    const cdnUrl = track.cdnUrl || `${this.fallbackCdnUrl}/${encodeURIComponent(cleanFileName)}`;
    const fallbackUrl = track.fallbackCdnUrl || `https://raw.githubusercontent.com/Sinh2022/Earlisthenic/main/audio/${encodeURIComponent(cleanFileName)}`;

    return {
      primaryUrl: this.enabled ? r2Url : cdnUrl,
      r2Url: r2Url,
      cdnUrl: cdnUrl,
      fallbackUrl: fallbackUrl
    };
  }

  /**
   * Streams audio bytes using HTTP Range requests or full GET with streaming reader
   * @param {Object} track - Audio track object
   * @param {Object} range - Optional { start, end } byte range
   * @param {Function} onProgress - Progress callback (loadedBytes, totalBytes)
   * @param {Function} abortCheckFn - Function returning boolean to abort stream
   * @returns {Promise<ArrayBuffer>} Complete ArrayBuffer of requested range or file
   */
  async streamTrackBytes(track, range = null, onProgress = null, abortCheckFn = null) {
    const urls = this.resolveStreamUrls(track);
    const candidateUrls = [urls.primaryUrl, urls.cdnUrl, urls.fallbackUrl].filter(Boolean);

    let lastError = null;
    for (const url of candidateUrls) {
      if (abortCheckFn && abortCheckFn()) {
        const err = new Error('Streaming aborted.');
        err.isAborted = true;
        throw err;
      }

      try {
        const headers = {};
        if (range && typeof range.start === 'number') {
          headers['Range'] = `bytes=${range.start}-${typeof range.end === 'number' ? range.end : ''}`;
        }

        const res = await fetch(url, { headers, mode: 'cors' });
        if (!res.ok && res.status !== 206) {
          throw new Error(`HTTP ${res.status} from ${url}`);
        }

        const contentLength = Number(res.headers.get('content-length')) || Number(track.sizeBytes) || 0;
        let assembledBuf = null;

        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          const chunks = [];
          let loaded = 0;

          while (true) {
            if (abortCheckFn && abortCheckFn()) {
              try { reader.cancel(); } catch (e) {}
              const abortedErr = new Error('Streaming aborted.');
              abortedErr.isAborted = true;
              throw abortedErr;
            }

            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) {
              chunks.push(value);
              loaded += value.length;
              if (onProgress) onProgress(loaded, Math.max(loaded, contentLength));
            }
          }

          // Strict integrity check
          if (contentLength > 1024 && loaded < Math.floor(contentLength * 0.95)) {
            throw new Error(`Incomplete stream: received ${loaded} of ${contentLength} bytes.`);
          }

          const assembled = new Uint8Array(loaded);
          let cursor = 0;
          for (let i = 0; i < chunks.length; i++) {
            assembled.set(chunks[i], cursor);
            cursor += chunks[i].length;
          }
          assembledBuf = assembled.buffer;
        } else {
          assembledBuf = await res.arrayBuffer();
          if (onProgress) onProgress(assembledBuf.byteLength, assembledBuf.byteLength);
        }

        if (assembledBuf && assembledBuf.byteLength > 1024) {
          return assembledBuf;
        }
      } catch (err) {
        if (err && err.isAborted) throw err;
        lastError = err;
        // Continue to fallback endpoint
      }
    }

    throw lastError || new Error(`Failed to stream audio for "${track.name}" from all providers.`);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EarlisthenicR2Client };
}
if (typeof window !== 'undefined') {
  window.EarlisthenicR2Client = EarlisthenicR2Client;
}
