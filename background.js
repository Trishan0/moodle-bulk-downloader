// background.js - Service worker (MV3 — no importScripts after install)

const activeDownloadIds = new Set();

// cancelRequested is stored in chrome.storage.session so it survives service-worker
// restarts that can occur between a 'download' message and a later 'cancel' message.
async function getCancelRequested() {
  const { cancelRequested = false } = await chrome.storage.session.get('cancelRequested');
  return cancelRequested;
}
function setCancelRequested(value) {
  return chrome.storage.session.set({ cancelRequested: value });
}

// ── Filename resolution ───────────────────────────────────────────────────────
// Strategy: HEAD first (fast), fall back to GET with Range:0-0 (some servers
// only send Content-Disposition on GET), then parse final URL pathname.
async function resolveFilename(url, fallbackName, fallbackExt) {
  try {
    // 1. Try HEAD
    let resp = await fetch(url, { method: 'HEAD', credentials: 'include', redirect: 'follow' });
    let name = extractFilenameFromResponse(resp);
    if (name) return name;

    // 2. Try GET with Range header (videos / large files often need this)
    resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      headers: { Range: 'bytes=0-0' }
    });
    name = extractFilenameFromResponse(resp);
    if (name) return name;

    // 3. Parse final redirected URL pathname
    const finalUrl = resp.url || url;
    const pathname = new URL(finalUrl).pathname;
    const parts = pathname.split('/');
    const last = decodeURIComponent(parts[parts.length - 1]);
    if (last && last.includes('.') && !last.startsWith('view.php')) return last;

    // 4. Infer extension from Content-Type
    const ct = resp.headers.get('content-type') || '';
    const inferredExt = inferExtFromContentType(ct) || fallbackExt;
    return buildSlug(fallbackName, inferredExt);

  } catch (e) {
    return buildSlug(fallbackName, fallbackExt);
  }
}

function extractFilenameFromResponse(resp) {
  const cd = resp.headers.get('content-disposition');
  if (!cd) return null;
  // filename*=UTF-8''encoded  (RFC 5987 — highest priority)
  let m = cd.match(/filename\*=UTF-8''([^;\s]+)/i);
  if (m) return decodeURIComponent(m[1].trim());
  // filename="quoted"
  m = cd.match(/filename="([^"]+)"/i);
  if (m) return m[1].trim();
  // filename=unquoted
  m = cd.match(/filename=([^;\s]+)/i);
  if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
  return null;
}

function inferExtFromContentType(ct) {
  const map = {
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt',
    'application/zip': 'zip',
    'video/mp4': 'mp4', 'video/mpeg': 'mpeg', 'video/webm': 'webm',
    'video/x-msvideo': 'avi', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
    'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  };
  for (const [mime, ext] of Object.entries(map)) {
    if (ct.includes(mime)) return ext;
  }
  return null;
}

function buildSlug(name, ext) {
  const slug = (name || 'file')
    .replace(/[^a-zA-Z0-9\s\-_.]/g, '').trim().replace(/\s+/g, '_').slice(0, 60);
  const cleanExt = ext && ext !== 'file' && ext !== 'img' ? '.' + ext : '';
  return slug + cleanExt;
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'resolveFilenames') {
    Promise.all(
      msg.files.map(async f => ({
        ...f,
        resolvedName: await resolveFilename(f.url, f.name, f.ext)
      }))
    ).then(files => sendResponse({ files }));
    return true;
  }

  if (msg.action === 'download') {
    setCancelRequested(false);
    chrome.downloads.download({
      url: msg.url,
      filename: msg.filename,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (downloadId !== undefined) {
        activeDownloadIds.add(downloadId);
        sendResponse({ downloadId });
      } else {
        sendResponse({ error: chrome.runtime.lastError?.message });
      }
    });
    return true;
  }

  if (msg.action === 'cancel') {
    setCancelRequested(true);
    Promise.all(
      [...activeDownloadIds].map(id => new Promise(res => chrome.downloads.cancel(id, res)))
    ).then(() => {
      activeDownloadIds.clear();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.action === 'checkCancel') {
    getCancelRequested().then(cancelled => sendResponse({ cancelled }));
    return true;
  }

  // Fetch a single file as Uint8Array for ZIP building (called per-file from popup)
  if (msg.action === 'fetchBytes') {
    getCancelRequested().then(cancelled => {
      if (cancelled) { sendResponse({ cancelled: true }); return; }
      fetch(msg.url, { credentials: 'include', redirect: 'follow' })
        .then(async resp => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const ab = await resp.arrayBuffer();
          // Send Uint8Array directly — structured clone handles it with no encoding overhead
          sendResponse({ bytes: new Uint8Array(ab) });
        })
        .catch(e => sendResponse({ error: e.message }));
    });
    return true;
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
    activeDownloadIds.delete(delta.id);
  }
});
