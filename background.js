// background.js - Service worker for Moodle Bulk Downloader v3

// Track active download IDs so we can cancel them
const activeDownloadIds = new Set();
let cancelRequested = false;

// ── Filename resolution ──────────────────────────────────────────────────────

/**
 * Follow the Moodle redirect and read Content-Disposition to get the real filename.
 * Falls back to URL pathname if header isn't present.
 */
async function resolveFilename(url, fallbackName, fallbackExt) {
  try {
    const resp = await fetch(url, { method: 'HEAD', credentials: 'include' });
    const cd = resp.headers.get('content-disposition');
    if (cd) {
      // Try filename*=UTF-8''encoded or filename="..."
      let match = cd.match(/filename\*=UTF-8''([^;]+)/i);
      if (match) return decodeURIComponent(match[1].trim());
      match = cd.match(/filename="([^"]+)"/i);
      if (match) return match[1].trim();
      match = cd.match(/filename=([^;]+)/i);
      if (match) return match[1].trim().replace(/^['"]|['"]$/g, '');
    }
    // Try final URL pathname after redirect
    const finalPath = new URL(resp.url).pathname;
    const parts = finalPath.split('/');
    const last = decodeURIComponent(parts[parts.length - 1]);
    if (last && last.includes('.')) return last;
  } catch (e) {
    // Network error, fall through
  }
  // Build from name + ext
  const slug = fallbackName.replace(/[^a-zA-Z0-9\s\-_.]/g, '').trim().replace(/\s+/g, '_').slice(0, 60);
  return slug + (fallbackExt && fallbackExt !== 'file' && fallbackExt !== 'img' ? '.' + fallbackExt : '');
}

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Resolve real filename for a single file
  if (msg.action === 'resolveFilename') {
    resolveFilename(msg.url, msg.name, msg.ext).then(name => sendResponse({ name }));
    return true;
  }

  // Resolve filenames for a batch
  if (msg.action === 'resolveFilenames') {
    Promise.all(
      msg.files.map(async f => ({
        ...f,
        resolvedName: await resolveFilename(f.url, f.name, f.ext)
      }))
    ).then(files => sendResponse({ files }));
    return true;
  }

  // Individual download with tracked ID
  if (msg.action === 'download') {
    cancelRequested = false;
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

  // Cancel: stop loop + cancel any in-flight downloads
  if (msg.action === 'cancel') {
    cancelRequested = true;
    const promises = [...activeDownloadIds].map(id =>
      new Promise(res => chrome.downloads.cancel(id, res))
    );
    Promise.all(promises).then(() => {
      activeDownloadIds.clear();
      sendResponse({ ok: true });
    });
    return true;
  }

  // Check cancel flag (polled by popup during loop)
  if (msg.action === 'checkCancel') {
    sendResponse({ cancelled: cancelRequested });
    return true;
  }

  // Build ZIP: fetch all files as blobs, return as base64 data URL
  if (msg.action === 'buildZip') {
    cancelRequested = false;
    buildZip(msg.files, msg.zipName, (progress) => {
      // Send progress updates to popup via storage (service workers can't push to popup directly)
      chrome.storage.session.set({ zipProgress: progress });
    }).then(result => {
      sendResponse(result);
    });
    return true;
  }
});

// ── ZIP builder ──────────────────────────────────────────────────────────────

async function buildZip(files, zipName, onProgress) {
  // Dynamically load JSZip from the extension bundle
  // We'll use a simple manual ZIP builder to avoid needing external libs
  // Actually import JSZip (bundled as jszip.min.js)
  try {
    importScripts('jszip.min.js');
  } catch(e) {
    return { error: 'JSZip not loaded: ' + e.message };
  }

  const zip = new JSZip();
  const usedNames = {};

  for (let i = 0; i < files.length; i++) {
    if (cancelRequested) {
      return { cancelled: true };
    }

    const file = files[i];
    onProgress({ current: i, total: files.length, name: file.resolvedName || file.name, phase: 'fetch' });

    try {
      const resp = await fetch(file.url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();

      // Deduplicate filenames inside the ZIP
      let fname = file.resolvedName || file.name;
      if (usedNames[fname] !== undefined) {
        usedNames[fname]++;
        const dot = fname.lastIndexOf('.');
        fname = dot > 0
          ? fname.slice(0, dot) + ` (${usedNames[fname]})` + fname.slice(dot)
          : fname + ` (${usedNames[fname]})`;
      } else {
        usedNames[fname] = 0;
      }

      zip.file(fname, blob);
    } catch(e) {
      console.warn('Failed to fetch for ZIP:', file.url, e);
      // Continue with remaining files
    }
  }

  if (cancelRequested) return { cancelled: true };

  onProgress({ current: files.length, total: files.length, name: '', phase: 'compress' });

  try {
    const content = await zip.generateAsync({
      type: 'base64',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    }, (meta) => {
      onProgress({ current: files.length, total: files.length, name: '', phase: 'compress', percent: meta.percent });
    });

    return { base64: content, zipName };
  } catch(e) {
    return { error: 'ZIP generation failed: ' + e.message };
  }
}

// Clean up completed download IDs
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
    activeDownloadIds.delete(delta.id);
  }
});
