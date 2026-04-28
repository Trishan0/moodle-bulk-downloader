// background.js - Moodle Bulk Downloader v5

const activeDownloadIds = new Set();
let cancelRequested = false;

// ── H5P video resolver ────────────────────────────────────────────────────────
// Fetches the mod/hvp view page, extracts the real pluginfile.php video URL
// from the embedded H5PIntegration JSON object.
async function resolveHvpVideo(hvpViewUrl) {
  try {
    const resp = await fetch(hvpViewUrl, { credentials: 'include', redirect: 'follow' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    // H5P embeds a large JSON blob assigned to H5PIntegration or set via H5P.init
    // We look for pluginfile.php URLs inside it that look like video files
    const videoExtensions = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'mpeg', 'ogv', 'm4v'];

    // Pattern 1: any pluginfile.php URL ending in a video extension
    const pluginfileRegex = /https?:\/\/[^"'\s]+\/pluginfile\.php\/[^"'\s]+\.(mp4|webm|mov|avi|mkv|mpeg|ogv|m4v)/gi;
    const matches = [...html.matchAll(pluginfileRegex)];
    if (matches.length > 0) {
      // Pick the first one (usually the best quality / main video)
      // Decode any JSON unicode escapes (\u002F → /)
      const raw = matches[0][0];
      const decoded = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
                         .replace(/\\\//g, '/');
      return { url: decoded, ext: decoded.split('.').pop().split('?')[0] || 'mp4' };
    }

    // Pattern 2: JSON-escaped version  "path":"\/pluginfile.php\/..."
    const escapedRegex = /\\\/pluginfile\.php\\\/[^"'\s\\]+\.(mp4|webm|mov|avi|mkv|mpeg|ogv|m4v)/gi;
    const escaped = [...html.matchAll(escapedRegex)];
    if (escaped.length > 0) {
      const origin = new URL(hvpViewUrl).origin;
      const path = escaped[0][0].replace(/\\\//g, '/');
      return { url: origin + path, ext: path.split('.').pop() || 'mp4' };
    }

    return null; // no video found in this H5P content
  } catch(e) {
    console.warn('resolveHvpVideo failed for', hvpViewUrl, e);
    return null;
  }
}

// ── Filename resolution ───────────────────────────────────────────────────────
async function resolveFilename(url, fallbackName, fallbackExt) {
  // Skip HEAD/GET for H5P view pages — those return HTML not a file
  if (url.includes('/mod/hvp/view.php')) {
    return buildSlug(fallbackName, fallbackExt);
  }

  try {
    // 1. HEAD
    let resp = await fetch(url, { method: 'HEAD', credentials: 'include', redirect: 'follow' });
    let name = extractFilenameFromResponse(resp);
    if (name) return name;

    // 2. GET Range (videos often need this)
    resp = await fetch(url, {
      method: 'GET', credentials: 'include', redirect: 'follow',
      headers: { Range: 'bytes=0-0' }
    });
    name = extractFilenameFromResponse(resp);
    if (name) return name;

    // 3. Final URL pathname
    const finalUrl = resp.url || url;
    const pathname = new URL(finalUrl).pathname;
    const parts = pathname.split('/');
    const last = decodeURIComponent(parts[parts.length - 1]);
    if (last && last.includes('.') && !last.includes('view.php')) return last;

    // 4. Content-Type sniff
    const ct = resp.headers.get('content-type') || '';
    return buildSlug(fallbackName, inferExtFromContentType(ct) || fallbackExt);

  } catch(e) {
    return buildSlug(fallbackName, fallbackExt);
  }
}

function extractFilenameFromResponse(resp) {
  const cd = resp.headers.get('content-disposition');
  if (!cd) return null;
  let m = cd.match(/filename\*=UTF-8''([^;\s]+)/i);
  if (m) return decodeURIComponent(m[1].trim());
  m = cd.match(/filename="([^"]+)"/i);
  if (m) return m[1].trim();
  m = cd.match(/filename=([^;\s]+)/i);
  if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
  return null;
}

function inferExtFromContentType(ct) {
  const map = {
    'application/pdf':'pdf', 'application/msword':'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
    'application/vnd.ms-powerpoint':'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx',
    'application/vnd.ms-excel':'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
    'text/plain':'txt', 'application/zip':'zip',
    'video/mp4':'mp4', 'video/mpeg':'mpeg', 'video/webm':'webm',
    'video/x-msvideo':'avi', 'video/quicktime':'mov', 'video/x-matroska':'mkv',
    'audio/mpeg':'mp3', 'audio/ogg':'ogg', 'audio/wav':'wav',
  };
  for (const [mime, ext] of Object.entries(map)) {
    if (ct.includes(mime)) return ext;
  }
  return null;
}

function buildSlug(name, ext) {
  const slug = (name||'file').replace(/[^a-zA-Z0-9\s\-_.]/g,'').trim().replace(/\s+/g,'_').slice(0,60);
  const cleanExt = ext && ext!=='file' && ext!=='img' ? '.'+ext : '';
  return slug + cleanExt;
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Batch filename + HVP resolution combined
  if (msg.action === 'resolveFilenames') {
    Promise.all(
      msg.files.map(async f => {
        if (f.hvp) {
          // For H5P: first extract real video URL, then get its filename
          const hvpResult = await resolveHvpVideo(f.url);
          if (hvpResult) {
            const realUrl = hvpResult.url;
            const realExt = hvpResult.ext;
            // Try to get a proper filename from the real URL
            const realName = await resolveFilename(realUrl, f.name, realExt);
            return { ...f, url: realUrl, ext: realExt, resolvedName: realName, hvpResolved: true };
          }
          // H5P page had no video (maybe it's a quiz/interactive — skip gracefully)
          return { ...f, hvpFailed: true, resolvedName: buildSlug(f.name, f.ext) };
        }
        return { ...f, resolvedName: await resolveFilename(f.url, f.name, f.ext) };
      })
    ).then(files => sendResponse({ files }));
    return true;
  }

  if (msg.action === 'download') {
    cancelRequested = false;
    chrome.downloads.download({
      url: msg.url, filename: msg.filename, conflictAction: 'uniquify'
    }, downloadId => {
      if (downloadId !== undefined) { activeDownloadIds.add(downloadId); sendResponse({ downloadId }); }
      else sendResponse({ error: chrome.runtime.lastError?.message });
    });
    return true;
  }

  if (msg.action === 'cancel') {
    cancelRequested = true;
    Promise.all([...activeDownloadIds].map(id => new Promise(res => chrome.downloads.cancel(id, res))))
      .then(() => { activeDownloadIds.clear(); sendResponse({ ok: true }); });
    return true;
  }

  if (msg.action === 'checkCancel') {
    sendResponse({ cancelled: cancelRequested });
    return true;
  }

  if (msg.action === 'fetchBase64') {
    if (cancelRequested) { sendResponse({ cancelled: true }); return true; }
    fetch(msg.url, { credentials: 'include', redirect: 'follow' })
      .then(async resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const ab = await resp.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let binary = '';
        // Process in chunks to avoid call stack overflow on large files
        const CHUNK = 8192;
        for (let i = 0; i < bytes.byteLength; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        sendResponse({ base64: btoa(binary) });
      })
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }
});

chrome.downloads.onChanged.addListener(delta => {
  if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
    activeDownloadIds.delete(delta.id);
  }
});
