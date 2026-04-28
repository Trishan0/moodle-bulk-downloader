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

// ── Folder resolver ───────────────────────────────────────────────────────────
// Fetches /mod/folder/view.php, parses all pluginfile.php links inside it,
// and returns them as individual file entries.
async function resolveFolderFiles(folderViewUrl, folderName) {
  try {
    const resp = await fetch(folderViewUrl, { credentials: 'include', redirect: 'follow' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    // Parse the HTML into a DOM so we can query it properly
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const files = [];
    const seen = new Set();

    // Moodle folder pages list files as <a href="pluginfile.php/..."> links
    doc.querySelectorAll('a[href*="pluginfile.php"]').forEach(anchor => {
      const href = anchor.href || anchor.getAttribute('href');
      if (!href || seen.has(href)) return;
      // Skip "download folder as zip" button — it's a mod/folder download link
      if (href.includes('mod/folder') && href.includes('download=')) return;
      seen.add(href);

      // Get display name from link text or filename in URL
      let name = anchor.textContent.trim().replace(/\s+/g, ' ');
      if (!name || name.length < 2) {
        const parts = decodeURIComponent(new URL(href).pathname).split('/');
        name = parts[parts.length - 1];
      }

      // Detect type from URL
      const typeInfo = detectTypeFromUrl(href) || { ext: 'file', cat: 'docs', label: 'File' };

      files.push({
        url: href,
        name: name,
        folderName: folderName,   // keep track of which folder it came from
        ...typeInfo,
      });
    });

    return files;
  } catch(e) {
    console.warn('resolveFolderFiles failed for', folderViewUrl, e);
    return [];
  }
}

function detectTypeFromUrl(url) {
  const ICON_MAP = [
    { keys: ['pdf'],                                ext: 'pdf',  cat: 'docs',  label: 'PDF' },
    { keys: ['docx', 'doc', 'odt'],                ext: 'docx', cat: 'docs',  label: 'Word' },
    { keys: ['pptx', 'ppt'],                       ext: 'pptx', cat: 'docs',  label: 'PPT' },
    { keys: ['xlsx', 'xls'],                       ext: 'xlsx', cat: 'docs',  label: 'Excel' },
    { keys: ['txt'],                               ext: 'txt',  cat: 'docs',  label: 'TXT' },
    { keys: ['zip', 'rar', '7z', 'tar', 'gz'],    ext: 'zip',  cat: 'docs',  label: 'ZIP' },
    { keys: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'mpeg', 'ogv'],
                                                   ext: 'mp4',  cat: 'video', label: 'Video' },
    { keys: ['mp3', 'wav', 'ogg', 'aac', 'flac'], ext: 'mp3',  cat: 'audio', label: 'Audio' },
    { keys: ['png', 'jpg', 'jpeg', 'gif', 'svg'], ext: 'img',  cat: 'image', label: 'Image' },
  ];
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,5})(\?|$)/);
    if (match) {
      const ext = match[1];
      for (const entry of ICON_MAP) {
        if (entry.keys.includes(ext)) return entry;
      }
      return { ext, cat: 'docs', label: ext.toUpperCase() };
    }
  } catch(e) {}
  return null;
}


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

  // Batch filename + HVP + folder resolution combined
  if (msg.action === 'resolveFilenames') {
    Promise.all(
      msg.files.map(async f => {
        // ── Folder: expand into child files ──
        if (f.folder) {
          const children = await resolveFolderFiles(f.url, f.name);
          if (children.length === 0) return []; // empty or failed folder
          // Resolve real filenames for each child too
          const resolved = await Promise.all(
            children.map(async c => ({
              ...c,
              resolvedName: await resolveFilename(c.url, c.name, c.ext),
            }))
          );
          return resolved; // returns an array — will be flattened below
        }

        // ── H5P: extract real video URL ──
        if (f.hvp) {
          const hvpResult = await resolveHvpVideo(f.url);
          if (hvpResult) {
            const realName = await resolveFilename(hvpResult.url, f.name, hvpResult.ext);
            return [{ ...f, url: hvpResult.url, ext: hvpResult.ext, resolvedName: realName, hvpResolved: true }];
          }
          return [{ ...f, hvpFailed: true, resolvedName: buildSlug(f.name, f.ext) }];
        }

        // ── Normal file ──
        return [{ ...f, resolvedName: await resolveFilename(f.url, f.name, f.ext) }];
      })
    ).then(results => {
      // Flatten: folders expand to multiple entries, others are single-element arrays
      const flat = results.flat().filter(f => !f.hvpFailed);
      sendResponse({ files: flat });
    });
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
