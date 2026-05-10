// background.js - Moodle Bulk Downloader v2.0
// MV3 service worker — module type

// ── Globals ───────────────────────────────────────────────────────────────────
const downloadControllers = new Map(); // downloadSessionId → AbortController
let globalAbortController = null;

// ── Concurrency queue ─────────────────────────────────────────────────────────
// Limits parallel async tasks to avoid hammering Moodle with 50+ simultaneous requests
function createQueue(concurrency = 5) {
  let running = 0;
  const queue = [];
  const next = () => {
    while (running < concurrency && queue.length) {
      running++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(resolve).catch(reject).finally(() => { running--; next(); });
    }
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// ── Retry helper ──────────────────────────────────────────────────────────────
async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (resp.ok || resp.status === 206) return resp;
      if (resp.status === 404 || resp.status === 403) throw new Error(`HTTP ${resp.status}`);
      // 5xx or other transient — retry
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (attempt === retries - 1) throw e;
    }
    await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
  }
}

// ── Unicode-safe filename sanitiser ──────────────────────────────────────────
// Keeps all Unicode letters/digits, only strips chars illegal on Windows/Mac/Linux filesystems
function sanitiseFilename(name) {
  if (!name) return 'file';
  return name
    .replace(/[/\\:*?"<>|]/g, '_')   // filesystem-illegal chars
    .replace(/[\x00-\x1f]/g, '')      // control characters
    .replace(/^\.+/, '')              // leading dots
    .trim()
    .slice(0, 200)                    // max length
    || 'file';
}

// ── H5P video resolver ────────────────────────────────────────────────────────
async function resolveHvpVideo(hvpViewUrl, signal) {
  try {
    const resp = await fetchWithRetry(hvpViewUrl, { credentials: 'include', redirect: 'follow', signal });
    if (!resp) return null;
    const html = await resp.text();

    const pluginfileRegex = /https?:\/\/[^"'\s]+\/pluginfile\.php\/[^"'\s]+\.(mp4|webm|mov|avi|mkv|mpeg|ogv|m4v)/gi;
    const matches = [...html.matchAll(pluginfileRegex)];
    if (matches.length > 0) {
      const raw = matches[0][0];
      const decoded = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
                         .replace(/\\\//g, '/');
      return { url: decoded, ext: decoded.split('.').pop().split('?')[0] || 'mp4' };
    }

    const escapedRegex = /\\\/pluginfile\.php\\\/[^"'\s\\]+\.(mp4|webm|mov|avi|mkv|mpeg|ogv|m4v)/gi;
    const escaped = [...html.matchAll(escapedRegex)];
    if (escaped.length > 0) {
      const origin = new URL(hvpViewUrl).origin;
      const path = escaped[0][0].replace(/\\\//g, '/');
      return { url: origin + path, ext: path.split('.').pop() || 'mp4' };
    }
    return null;
  } catch(e) {
    if (e.name !== 'AbortError') console.warn('resolveHvpVideo failed for', hvpViewUrl, e);
    return null;
  }
}

// ── Folder resolver ───────────────────────────────────────────────────────────
async function resolveFolderFiles(folderViewUrl, folderName, signal) {
  try {
    const resp = await fetchWithRetry(folderViewUrl, { credentials: 'include', redirect: 'follow', signal });
    if (!resp) return [];
    const html = await resp.text();

    // Parse HTML using regex since DOMParser is not available in all SW contexts
    const files = [];
    const seen = new Set();

    // Match all anchor tags with pluginfile.php hrefs
    const anchorRegex = /<a\s[^>]*href="([^"]*pluginfile\.php[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = anchorRegex.exec(html)) !== null) {
      let href = m[1];
      if (!href || seen.has(href)) continue;
      if (href.includes('mod/folder') && href.includes('download=')) continue;

      // Decode HTML entities in href
      href = href.replace(/&amp;/g, '&').replace(/&#39;/g, "'");
      seen.add(href);

      // Extract text content from inner HTML
      const innerText = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const urlParts = decodeURIComponent(new URL(href, folderViewUrl).pathname).split('/');
      const name = innerText.length > 1 ? innerText : urlParts[urlParts.length - 1];

      const typeInfo = detectTypeFromUrl(href) || { ext: 'file', cat: 'docs', label: 'File' };
      files.push({ url: href, name, folderName, ...typeInfo });
    }
    return files;
  } catch(e) {
    if (e.name !== 'AbortError') console.warn('resolveFolderFiles failed for', folderViewUrl, e);
    return [];
  }
}

// ── Type detection ────────────────────────────────────────────────────────────
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

function detectTypeFromUrl(url) {
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

// ── Filename resolution ───────────────────────────────────────────────────────
async function resolveFilename(url, fallbackName, fallbackExt, signal) {
  if (url.includes('/mod/hvp/view.php')) {
    return sanitiseFilename(fallbackName) + (fallbackExt && fallbackExt !== 'file' ? '.' + fallbackExt : '');
  }
  try {
    let resp = await fetchWithRetry(url, { method: 'HEAD', credentials: 'include', redirect: 'follow', signal });
    let name = resp ? extractFilenameFromResponse(resp) : null;
    if (name) return name;

    resp = await fetchWithRetry(url, {
      method: 'GET', credentials: 'include', redirect: 'follow', signal,
      headers: { Range: 'bytes=0-0' }
    });
    if (resp) {
      name = extractFilenameFromResponse(resp);
      if (name) return name;

      const finalUrl = resp.url || url;
      const pathname = new URL(finalUrl).pathname;
      const parts = pathname.split('/');
      const last = decodeURIComponent(parts[parts.length - 1]);
      if (last && last.includes('.') && !last.includes('view.php')) return last;

      const ct = resp.headers.get('content-type') || '';
      const ext = inferExtFromContentType(ct) || fallbackExt;
      return sanitiseFilename(fallbackName) + (ext && ext !== 'file' ? '.' + ext : '');
    }
  } catch(e) {
    if (e.name !== 'AbortError') console.warn('resolveFilename error', url, e.message);
  }
  return sanitiseFilename(fallbackName) + (fallbackExt && fallbackExt !== 'file' && fallbackExt !== 'img' ? '.' + fallbackExt : '');
}

// ── File size resolution ──────────────────────────────────────────────────────
async function resolveFileSize(url, signal) {
  try {
    const resp = await fetch(url, { method: 'HEAD', credentials: 'include', redirect: 'follow', signal });
    if (resp && resp.ok) {
      const cl = resp.headers.get('content-length');
      if (cl) return parseInt(cl, 10);
    }
  } catch(e) {}
  return null;
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

// ── Context menu setup ────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'moodle-scan',
    title: 'Scan page for downloadable files',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'moodle-scan') {
    chrome.action.openPopup().catch(() => {
      // openPopup not available in all contexts — fallback: open as tab
      chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
    });
  }
});

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Resolve filenames, sizes, H5P, folders ──
  if (msg.action === 'resolveFilenames') {
    globalAbortController = new AbortController();
    const { signal } = globalAbortController;
    const limit = createQueue(5); // max 5 concurrent

    Promise.all(
      msg.files.map(f => limit(async () => {
        if (signal.aborted) return [];

        // Folder expansion
        if (f.folder) {
          const children = await resolveFolderFiles(f.url, f.name, signal);
          if (!children.length) return [];
          return Promise.all(children.map(async c => ({
            ...c,
            resolvedName: await resolveFilename(c.url, c.name, c.ext, signal),
            fileSize: await resolveFileSize(c.url, signal),
          })));
        }

        // H5P video resolution
        if (f.hvp) {
          const hvpResult = await resolveHvpVideo(f.url, signal);
          if (hvpResult) {
            return [{
              ...f,
              url: hvpResult.url,
              ext: hvpResult.ext,
              resolvedName: await resolveFilename(hvpResult.url, f.name, hvpResult.ext, signal),
              fileSize: await resolveFileSize(hvpResult.url, signal),
              hvpResolved: true,
            }];
          }
          return [{ ...f, hvpFailed: true }];
        }

        // Normal file
        return [{
          ...f,
          resolvedName: await resolveFilename(f.url, f.name, f.ext, signal),
          fileSize: await resolveFileSize(f.url, signal),
        }];
      }))
    ).then(results => {
      const flat = results.flat().filter(f => !f.hvpFailed);
      sendResponse({ files: flat });
    }).catch(e => {
      sendResponse({ files: msg.files, error: e.message });
    });
    return true;
  }

  // ── Individual file download ──
  if (msg.action === 'download') {
    chrome.downloads.download({
      url: msg.url, filename: msg.filename, conflictAction: 'uniquify'
    }, downloadId => {
      if (downloadId !== undefined) sendResponse({ downloadId });
      else sendResponse({ error: chrome.runtime.lastError?.message || 'Download failed' });
    });
    return true;
  }

  // ── Cancel everything ──
  if (msg.action === 'cancel') {
    if (globalAbortController) globalAbortController.abort();
    // Also cancel all active chrome.downloads
    chrome.downloads.search({ state: 'in_progress' }, downloads => {
      downloads.forEach(d => chrome.downloads.cancel(d.id));
      sendResponse({ ok: true });
    });
    return true;
  }

  // ── Fetch file as base64 (for ZIP mode) ──
  if (msg.action === 'fetchBase64') {
    const controller = new AbortController();
    const sessionId = msg.sessionId || Date.now().toString();
    downloadControllers.set(sessionId, controller);

    fetch(msg.url, { credentials: 'include', redirect: 'follow', signal: controller.signal })
      .then(async resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const ab = await resp.arrayBuffer();
        const bytes = new Uint8Array(ab);
        const CHUNK = 8192;
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        downloadControllers.delete(sessionId);
        sendResponse({ base64: btoa(binary), sessionId });
      })
      .catch(e => {
        downloadControllers.delete(sessionId);
        if (e.name === 'AbortError') sendResponse({ cancelled: true });
        else sendResponse({ error: e.message });
      });
    return true;
  }

  // ── Cancel a specific fetch session ──
  if (msg.action === 'cancelFetch') {
    const ctrl = downloadControllers.get(msg.sessionId);
    if (ctrl) { ctrl.abort(); downloadControllers.delete(msg.sessionId); }
    sendResponse({ ok: true });
    return true;
  }

  // ── Save download history entry ──
  if (msg.action === 'saveHistory') {
    chrome.storage.local.get({ downloadHistory: [] }, data => {
      const history = data.downloadHistory;
      history.unshift(msg.entry);
      if (history.length > 50) history.length = 50; // keep last 50 sessions
      chrome.storage.local.set({ downloadHistory: history }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  // ── Get download history ──
  if (msg.action === 'getHistory') {
    chrome.storage.local.get({ downloadHistory: [] }, data => {
      sendResponse({ history: data.downloadHistory });
    });
    return true;
  }

  // ── Clear history ──
  if (msg.action === 'clearHistory') {
    chrome.storage.local.set({ downloadHistory: [] }, () => sendResponse({ ok: true }));
    return true;
  }
});
