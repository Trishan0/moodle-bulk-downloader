// popup.js - Moodle Bulk Downloader v4
// ZIP is built here in the popup page (not the service worker) so JSZip loads fine.

let allFiles     = [];   // raw files from content scan
let resolvedFiles = [];  // files with .resolvedName set
let selectedIds  = new Set();
let activeFilter = 'all';
let downloadMode = 'individual';
let isDownloading = false;

// ── Categories ────────────────────────────────────────────────────────────────
const CATEGORIES = [
  { id:'all',   label:'All',    icon:'📦' },
  { id:'docs',  label:'Docs',   icon:'📄' },
  { id:'video', label:'Videos', icon:'🎬' },
  { id:'audio', label:'Audio',  icon:'🎵' },
  { id:'image', label:'Images', icon:'🖼️' },
];

// ── Badge colours ─────────────────────────────────────────────────────────────
const EXT_STYLE = {
  pdf:  {bg:'#3b1515',color:'#f87171'},
  docx: {bg:'#132240',color:'#60a5fa'},
  pptx: {bg:'#2d1a0e',color:'#fb923c'},
  xlsx: {bg:'#0f2a1e',color:'#34d399'},
  txt:  {bg:'#1a2e1a',color:'#86efac'},
  zip:  {bg:'#2a1f3a',color:'#c084fc'},
  mp4:  {bg:'#1f1a3a',color:'#a78bfa'},
  mp3:  {bg:'#1a2535',color:'#67e8f9'},
  img:  {bg:'#2a1a1a',color:'#fca5a5'},
  file: {bg:'#1e2535',color:'#9ca3af'},
};
const badgeStyle = ext => { const s=EXT_STYLE[ext]||EXT_STYLE.file; return `background:${s.bg};color:${s.color}`; };

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srcFiles = () => resolvedFiles.length ? resolvedFiles : allFiles;
function visibleFiles() {
  const src = srcFiles();
  return activeFilter === 'all' ? src : src.filter(f => f.cat === activeFilter);
}
function buildFallbackName(f) {
  const slug = (f.name||'file').replace(/[^a-zA-Z0-9\s\-_.]/g,'').trim().replace(/\s+/g,'_').slice(0,60);
  const ext  = f.ext && f.ext!=='file' && f.ext!=='img' ? '.'+f.ext : '';
  return slug + ext;
}
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Filter bar ────────────────────────────────────────────────────────────────
function renderFilterBar() {
  const bar = document.getElementById('filterBar');
  const counts = {all: allFiles.length};
  allFiles.forEach(f => { counts[f.cat] = (counts[f.cat]||0)+1; });
  bar.innerHTML = CATEGORIES
    .filter(c => c.id==='all' || counts[c.id])
    .map(c => {
      const active = activeFilter===c.id ? 'active' : '';
      return `<button class="filter-btn ${active}" data-filter="${c.id}">
        ${c.icon} ${c.label} <span class="filter-count">${counts[c.id]||0}</span>
      </button>`;
    }).join('');
  bar.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter;
      renderFilterBar(); renderFileList();
    });
  });
}

// ── File list ─────────────────────────────────────────────────────────────────
function renderFileList() {
  const list = document.getElementById('fileList');
  const files = visibleFiles();
  const src   = srcFiles();

  if (!files.length) {
    list.innerHTML = `<div class="empty-state"><div class="emoji">📭</div><p>No files in this category.</p></div>`;
    updateFooter(); return;
  }

  list.innerHTML = files.map(f => {
    const idx      = src.indexOf(f);
    const selected = selectedIds.has(idx);
    const display  = escapeHtml(f.resolvedName || f.name || 'Unnamed');
    const extLabel = escapeHtml(f.label || f.ext.toUpperCase());
    const dimmed   = !f.resolvedName && resolvedFiles.length === 0 ? 'resolving' : '';
    return `<div class="file-item ${selected?'selected':''}" data-idx="${idx}">
      <div class="file-checkbox">${selected?'✓':''}</div>
      <span class="ext-badge" style="${badgeStyle(f.ext)}">${extLabel}</span>
      <span class="file-name ${dimmed}" title="${display}">${display}</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.file-item').forEach(item => {
    item.addEventListener('click', () => {
      if (isDownloading) return;
      const idx = parseInt(item.dataset.idx);
      selectedIds.has(idx) ? selectedIds.delete(idx) : selectedIds.add(idx);
      renderFileList(); updateFooter();
    });
  });
  updateFooter();
}

// ── Footer ────────────────────────────────────────────────────────────────────
function updateFooter() {
  const btn       = document.getElementById('downloadBtn');
  const label     = document.getElementById('countLabel');
  const selAll    = document.getElementById('selectAll');
  const cancelBtn = document.getElementById('cancelBtn');

  label.textContent = selectedIds.size > 0 ? `${selectedIds.size} selected` : '';
  btn.disabled = selectedIds.size === 0 || isDownloading;
  btn.textContent = downloadMode==='zip' ? '🗜 Download ZIP' : '⬇ Download';

  const vis = visibleFiles();
  const src = srcFiles();
  const allSel = vis.length>0 && vis.every(f => selectedIds.has(src.indexOf(f)));
  selAll.textContent = allSel ? 'Deselect all' : 'Select all';
  selAll.style.opacity = isDownloading ? '.4' : '1';
  selAll.style.pointerEvents = isDownloading ? 'none' : '';
  cancelBtn.style.display = isDownloading ? 'block' : 'none';
}

// ── Select all ────────────────────────────────────────────────────────────────
document.getElementById('selectAll').addEventListener('click', () => {
  if (isDownloading) return;
  const src = srcFiles();
  const vis = visibleFiles();
  const allSel = vis.every(f => selectedIds.has(src.indexOf(f)));
  if (allSel) vis.forEach(f => selectedIds.delete(src.indexOf(f)));
  else        vis.forEach(f => selectedIds.add(src.indexOf(f)));
  renderFileList();
});

// ── Mode toggle ───────────────────────────────────────────────────────────────
document.getElementById('modeIndividual').addEventListener('click', () => {
  downloadMode = 'individual';
  document.getElementById('modeIndividual').classList.add('active');
  document.getElementById('modeZip').classList.remove('active');
  updateFooter();
});
document.getElementById('modeZip').addEventListener('click', () => {
  downloadMode = 'zip';
  document.getElementById('modeZip').classList.add('active');
  document.getElementById('modeIndividual').classList.remove('active');
  updateFooter();
});

// ── Cancel ────────────────────────────────────────────────────────────────────
document.getElementById('cancelBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'cancel' });
});

// ── Progress helpers ──────────────────────────────────────────────────────────
function showProgress(pct, msg) {
  document.getElementById('progressArea').style.display = 'block';
  document.getElementById('progressFill').style.width = Math.round(pct) + '%';
  document.getElementById('statusMsg').textContent = msg;
}
function hideProgress() {
  document.getElementById('progressArea').style.display = 'none';
  document.getElementById('progressFill').style.width = '0%';
}
function setDownloading(val) { isDownloading = val; updateFooter(); }

// ── Download button ───────────────────────────────────────────────────────────
document.getElementById('downloadBtn').addEventListener('click', async () => {
  const src = srcFiles();
  const toDownload = src.filter((_,i) => selectedIds.has(i));
  if (!toDownload.length) return;

  setDownloading(true);
  if (downloadMode === 'zip') await runZipDownload(toDownload);
  else                        await runIndividualDownload(toDownload);
  setDownloading(false);
  hideProgress();
});

// ── Individual downloads ──────────────────────────────────────────────────────
async function runIndividualDownload(files) {
  let done = 0;
  for (const file of files) {
    const { cancelled } = await chrome.runtime.sendMessage({ action: 'checkCancel' });
    if (cancelled) {
      showProgress((done/files.length)*100, `⛔ Cancelled after ${done} file${done!==1?'s':''}.`);
      await sleep(1800); return;
    }
    showProgress((done/files.length)*100,
      `Downloading ${done+1}/${files.length}: ${(file.resolvedName||file.name).slice(0,42)}…`);
    const filename = file.resolvedName || buildFallbackName(file);
    await chrome.runtime.sendMessage({ action:'download', url:file.url, filename });
    done++;
    await sleep(350);
  }
  showProgress(100, `✅ Done! ${done} file${done!==1?'s':''} sent to Downloads.`);
  await sleep(2000);
}

// ── ZIP download (runs in popup page — JSZip is loaded via <script> tag) ──────
async function runZipDownload(files) {
  if (typeof JSZip === 'undefined') {
    showProgress(0, '❌ JSZip failed to load. Try reloading the extension.');
    await sleep(3000); return;
  }

  const zip = new JSZip();
  const usedNames = {};

  for (let i = 0; i < files.length; i++) {
    const { cancelled } = await chrome.runtime.sendMessage({ action: 'checkCancel' });
    if (cancelled) {
      showProgress((i/files.length)*80, `⛔ Cancelled after ${i} file${i!==1?'s':''}.`);
      await sleep(1800); return;
    }

    const file  = files[i];
    const label = (file.resolvedName || file.name).slice(0,42);
    showProgress((i/files.length)*80, `Fetching ${i+1}/${files.length}: ${label}…`);

    // Ask background to fetch the file (has session cookies)
    const result = await chrome.runtime.sendMessage({ action:'fetchBytes', url:file.url });

    if (result.cancelled) {
      showProgress((i/files.length)*80, `⛔ Cancelled.`);
      await sleep(1800); return;
    }
    if (result.error) {
      console.warn('Skipping', file.url, result.error);
      continue; // skip failed files, keep going
    }

    // Deduplicate filenames inside the ZIP
    let fname = file.resolvedName || buildFallbackName(file);
    if (usedNames[fname] !== undefined) {
      usedNames[fname]++;
      const dot = fname.lastIndexOf('.');
      fname = dot > 0
        ? fname.slice(0,dot) + ` (${usedNames[fname]})` + fname.slice(dot)
        : fname + ` (${usedNames[fname]})`;
    } else {
      usedNames[fname] = 0;
    }

    // Add Uint8Array directly to the ZIP — no base64 encoding/decoding needed
    zip.file(fname, new Uint8Array(result.bytes));
  }

  showProgress(80, 'Compressing…');

  try {
    const blob = await zip.generateAsync(
      { type:'blob', compression:'DEFLATE', compressionOptions:{level:6} },
      meta => showProgress(80 + meta.percent * 0.19, `Compressing… ${Math.round(meta.percent)}%`)
    );

    // Build a safe ZIP filename from the page title
    const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
    const title = (tab?.title || 'moodle-materials')
      .replace(/[^a-zA-Z0-9\s\-_]/g,'').trim().replace(/\s+/g,'_').slice(0,50);
    const zipName = title + '.zip';

    // Create object URL and trigger download
    const objUrl = URL.createObjectURL(blob);
    await chrome.runtime.sendMessage({ action:'download', url:objUrl, filename:zipName });
    showProgress(100, `✅ ZIP saved as "${zipName}"`);
    // Revoke after a delay to allow Chrome to start the download
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
    await sleep(2500);
  } catch(e) {
    showProgress(0, `❌ ZIP failed: ${e.message}`);
    await sleep(3000);
  }
}

// ── Resolve real filenames via background HEAD/GET ────────────────────────────
async function resolveFilenames(files) {
  const banner     = document.getElementById('resolvingBanner');
  const bannerText = document.getElementById('resolvingText');
  banner.style.display = 'flex';

  return new Promise(resolve => {
    let tick = 0;
    const interval = setInterval(() => {
      tick = Math.min(tick+1, files.length-1);
      bannerText.textContent = `Resolving file names… (${tick}/${files.length})`;
    }, Math.max(200, Math.floor(3000 / files.length)));

    chrome.runtime.sendMessage({ action:'resolveFilenames', files }, response => {
      clearInterval(interval);
      banner.style.display = 'none';
      resolve(response?.files || files);
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const scanningEl = document.getElementById('scanning-state');
  try {
    const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });

    // Validate that the active tab is a regular http/https page.
    let tabOrigin;
    try {
      tabOrigin = new URL(tab.url).origin + '/*';
      if (!tab.url.startsWith('http')) throw new Error('non-http');
    } catch (_) {
      scanningEl.innerHTML = `
        <div class="empty-state" style="padding:28px">
          <div class="emoji">🚫</div>
          <p>This page can't be scanned.</p>
          <small>Navigate to your Moodle course page first.</small>
        </div>`;
      return;
    }

    // Request host permission for the current origin if not already granted.
    // This is an optional_host_permission — the browser will show a one-time prompt.
    const hasPermission = await chrome.permissions.contains({ origins: [tabOrigin] });
    if (!hasPermission) {
      const granted = await chrome.permissions.request({ origins: [tabOrigin] });
      if (!granted) {
        scanningEl.innerHTML = `
          <div class="empty-state" style="padding:28px">
            <div class="emoji">🔒</div>
            <p>Permission required.</p>
            <small>Click the extension icon again and allow access to this site.</small>
          </div>`;
        return;
      }
    }

    // Inject content script (idempotent — content.js guards against double-injection).
    try {
      await chrome.scripting.executeScript({ target:{ tabId:tab.id }, files:['content.js'] });
    } catch (e) {
      // executeScript can fail on protected pages (PDFs, browser-internal pages, etc.)
      scanningEl.innerHTML = `
        <div class="empty-state" style="padding:28px">
          <div class="emoji">⚠️</div>
          <p>Couldn't inject scanner.</p>
          <small>Make sure you're on a regular Moodle course page.</small>
        </div>`;
      return;
    }

    const response = await chrome.tabs.sendMessage(tab.id, { action:'scan' });
    allFiles = response?.files || [];
    allFiles.forEach((_,i) => selectedIds.add(i));

    scanningEl.style.display = 'none';
    document.getElementById('main').style.display = 'block';

    if (!allFiles.length) {
      document.getElementById('filterBar').style.display = 'none';
      document.getElementById('fileList').innerHTML = `
        <div class="empty-state">
          <div class="emoji">📭</div>
          <p>No downloadable files found on this page.</p>
          <small>Make sure you're on a Moodle course page with resources.</small>
        </div>`;
      return;
    }

    renderFilterBar();
    renderFileList();

    // Resolve in background — non-blocking, list updates when done
    resolveFilenames(allFiles).then(resolved => {
      resolvedFiles = resolved;
      renderFileList();
    });

  } catch(e) {
    scanningEl.innerHTML = `
      <div class="empty-state" style="padding:28px">
        <div class="emoji">⚠️</div>
        <p>Couldn't scan this page.</p>
        <small>Refresh the Moodle page and try again.</small>
      </div>`;
  }
}

init();
