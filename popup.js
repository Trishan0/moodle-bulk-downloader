// popup.js - Moodle Bulk Downloader v2.0

let allFiles      = [];
let resolvedFiles = [];
let selectedIds   = new Set();
let activeFilter  = 'all';
let downloadMode  = 'individual';
let isDownloading = false;
let searchQuery   = '';
let sortMode      = 'default';
let activeTab     = 'files';
let fileStatuses  = {};

const CATEGORIES = [
  { id:'all',    label:'All',    icon:'📦' },
  { id:'docs',   label:'Docs',   icon:'📄' },
  { id:'video',  label:'Video',  icon:'🎬' },
  { id:'audio',  label:'Audio',  icon:'🎵' },
  { id:'image',  label:'Images', icon:'🖼️' },
  { id:'folder', label:'Folder', icon:'📁' },
];

// ── Cache helpers ─────────────────────────────────────────────────────────────
// Key: tab URL (query-string stripped to course path). Value: resolved file list.
// chrome.storage.session is cleared on browser close — always fresh next session.

function cacheKey(url) {
  try {
    const u = new URL(url);
    // Keep only origin + pathname so ?section=X variations hit the same cache
    return 'cache:' + u.origin + u.pathname;
  } catch {
    return 'cache:' + url;
  }
}

async function getCached(url) {
  const key = cacheKey(url);
  return new Promise(resolve => {
    chrome.storage.session.get(key, result => {
      resolve(result[key] || null);
    });
  });
}

async function setCache(url, files) {
  const key = cacheKey(url);
  return new Promise(resolve => {
    chrome.storage.session.set({ [key]: files }, resolve);
  });
}

async function clearCache(url) {
  const key = cacheKey(url);
  return new Promise(resolve => chrome.storage.session.remove(key, resolve));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srcFiles = () => resolvedFiles.length ? resolvedFiles : allFiles;

function setText(el, str) { el.textContent = str; }

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function totalSelectedSize() {
  const src = srcFiles();
  let total = 0;
  for (const id of selectedIds) {
    const f = src[id];
    if (f && f.fileSize) total += f.fileSize;
  }
  return total > 0 ? total : null;
}

function badgeClass(ext, hvp, folder) {
  if (hvp) return 'badge-hvp';
  if (folder) return 'badge-file';
  return 'badge-' + (ext || 'file');
}

function badgeLabel(f) {
  if (f.hvp && !f.hvpResolved) return 'H5P';
  if (f.folder) return '📁';
  return (f.label || f.ext || 'FILE').toUpperCase().slice(0, 5);
}

function buildFallbackName(f) {
  const name = (f.name || 'file').replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 200);
  const ext = f.ext && f.ext !== 'file' && f.ext !== 'img' ? '.' + f.ext : '';
  return name + ext;
}

// ── Visible file list (search + filter + sort) ────────────────────────────────
function visibleFiles() {
  let src = srcFiles();
  const q = searchQuery.toLowerCase().trim();
  if (q) {
    src = src.filter(f => {
      const name = (f.resolvedName || f.name || '').toLowerCase();
      const label = (f.label || '').toLowerCase();
      const section = (f.sectionName || '').toLowerCase();
      const folder = (f.folderName || '').toLowerCase();
      return name.includes(q) || label.includes(q) || section.includes(q) || folder.includes(q);
    });
  }
  if (activeFilter !== 'all') src = src.filter(f => f.cat === activeFilter);
  const sorted = [...src];
  switch (sortMode) {
    case 'name-asc':  sorted.sort((a,b) => (a.resolvedName||a.name||'').localeCompare(b.resolvedName||b.name||'')); break;
    case 'name-desc': sorted.sort((a,b) => (b.resolvedName||b.name||'').localeCompare(a.resolvedName||a.name||'')); break;
    case 'type':      sorted.sort((a,b) => (a.ext||'').localeCompare(b.ext||'')); break;
    case 'size-desc': sorted.sort((a,b) => (b.fileSize||0) - (a.fileSize||0)); break;
    case 'size-asc':  sorted.sort((a,b) => (a.fileSize||0) - (b.fileSize||0)); break;
    case 'section':   sorted.sort((a,b) => (a.sectionName||'').localeCompare(b.sectionName||'')); break;
  }
  return sorted;
}

// ── Filter bar ────────────────────────────────────────────────────────────────
function renderFilterBar() {
  const bar = document.getElementById('filterBar');
  const src = srcFiles();
  const resolved = resolvedFiles.length > 0;
  const counts = { all: src.length };
  src.forEach(f => { counts[f.cat] = (counts[f.cat] || 0) + 1; });

  bar.innerHTML = '';
  CATEGORIES.filter(c => {
    if (c.id === 'all') return true;
    if (c.id === 'folder' && resolved) return false;
    return counts[c.id] > 0;
  }).forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn' + (activeFilter === c.id ? ' active' : '');
    btn.dataset.filter = c.id;
    btn.setAttribute('aria-pressed', activeFilter === c.id);
    btn.innerHTML = `${c.icon} ${c.label} <span class="filter-count">${counts[c.id]||0}</span>`;
    btn.addEventListener('click', () => {
      activeFilter = c.id;
      renderFilterBar();
      renderFileList();
    });
    bar.appendChild(btn);
  });
}

// ── File list ─────────────────────────────────────────────────────────────────
function renderFileList() {
  const listEl = document.getElementById('fileList');
  const fullSrc = srcFiles();
  const files = visibleFiles();

  if (!files.length) {
    listEl.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `<div class="emoji">📭</div>
      <p>${searchQuery ? 'No files match your search.' : 'No files in this category.'}</p>`;
    listEl.appendChild(empty);
    updateFooter();
    return;
  }

  listEl.innerHTML = '';
  files.forEach(f => {
    const idx = fullSrc.indexOf(f);
    const selected = selectedIds.has(idx);
    const status = fileStatuses[idx];
    const display = f.resolvedName || f.name || 'Unnamed';
    const dimmed = !f.resolvedName && !resolvedFiles.length;

    const item = document.createElement('div');
    item.className = 'file-item' +
      (selected ? ' selected' : '') +
      (status === 'done' ? ' done' : '') +
      (status === 'error' ? ' error' : '');
    item.dataset.idx = idx;
    item.tabIndex = 0;
    item.setAttribute('role', 'listitem');
    item.setAttribute('aria-selected', selected);
    item.setAttribute('aria-label', display);

    const check = document.createElement('div');
    check.className = 'file-check';
    check.setAttribute('aria-hidden', 'true');
    if (selected) check.textContent = '✓';
    item.appendChild(check);

    const badge = document.createElement('span');
    badge.className = 'ext-badge ' + badgeClass(f.ext, f.hvp && !f.hvpResolved, f.folder);
    badge.textContent = badgeLabel(f);
    item.appendChild(badge);

    const info = document.createElement('div');
    info.className = 'file-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'file-name' + (dimmed ? ' resolving' : '');
    nameEl.title = display;
    nameEl.textContent = display;
    info.appendChild(nameEl);

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const metaParts = [];
    if (f.folderName) metaParts.push('📁 ' + f.folderName.slice(0, 24));
    else if (f.sectionName) metaParts.push(f.sectionName.slice(0, 28));
    meta.textContent = metaParts.join(' · ');
    info.appendChild(meta);
    item.appendChild(info);

    if (f.fileSize) {
      const sizeEl = document.createElement('span');
      sizeEl.className = 'file-size';
      sizeEl.textContent = formatSize(f.fileSize);
      item.appendChild(sizeEl);
    }

    if (status) {
      const statusEl = document.createElement('span');
      statusEl.className = 'file-status';
      statusEl.textContent = status === 'done' ? '✅' : status === 'error' ? '❌' : '';
      item.appendChild(statusEl);
    }

    const toggle = () => {
      if (isDownloading) return;
      selectedIds.has(idx) ? selectedIds.delete(idx) : selectedIds.add(idx);
      renderFileList();
      updateFooter();
    };
    item.addEventListener('click', toggle);
    item.addEventListener('keydown', e => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
    });

    listEl.appendChild(item);
  });

  updateFooter();
}

// ── Footer ────────────────────────────────────────────────────────────────────
function updateFooter() {
  const btn       = document.getElementById('downloadBtn');
  const label     = document.getElementById('countLabel');
  const sizeEl    = document.getElementById('sizeLabel');
  const selAll    = document.getElementById('selectAll');
  const cancelBtn = document.getElementById('cancelBtn');
  const vis = visibleFiles();
  const fullSrc = srcFiles();

  const selCount = selectedIds.size;
  label.textContent = selCount > 0 ? `${selCount} selected` : '';
  const sz = totalSelectedSize();
  sizeEl.textContent = sz ? formatSize(sz) : '';

  btn.disabled = selCount === 0 || isDownloading;
  btn.textContent = downloadMode === 'zip' ? '🗜 Download ZIP' : '⬇ Download';

  const allVis = vis.length > 0 && vis.every(f => selectedIds.has(fullSrc.indexOf(f)));
  selAll.textContent = allVis ? 'Deselect all' : 'Select all';
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
document.getElementById('selectAll').addEventListener('keydown', e => {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); document.getElementById('selectAll').click(); }
});

// ── Search ────────────────────────────────────────────────────────────────────
document.getElementById('searchInput').addEventListener('input', e => {
  searchQuery = e.target.value;
  document.getElementById('searchClear').style.display = searchQuery ? 'block' : 'none';
  renderFileList();
});
document.getElementById('searchClear').addEventListener('click', () => {
  document.getElementById('searchInput').value = '';
  searchQuery = '';
  document.getElementById('searchClear').style.display = 'none';
  renderFileList();
});

// ── Sort ──────────────────────────────────────────────────────────────────────
document.getElementById('sortSelect').addEventListener('change', e => {
  sortMode = e.target.value;
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

// ── Progress ──────────────────────────────────────────────────────────────────
function showProgress(pct, msg) {
  document.getElementById('progressArea').style.display = 'block';
  document.getElementById('progressFill').style.width = Math.min(100, Math.round(pct)) + '%';
  document.getElementById('statusMsg').textContent = msg;
}
function hideProgress() {
  document.getElementById('progressArea').style.display = 'none';
  document.getElementById('progressFill').style.width = '0%';
}
function setDownloading(val) { isDownloading = val; updateFooter(); }

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'a' && document.activeElement.id !== 'searchInput') {
    e.preventDefault(); document.getElementById('selectAll').click();
  }
  if (e.key === 'Enter' && document.activeElement.tagName !== 'BUTTON' && document.activeElement.id !== 'searchInput') {
    const btn = document.getElementById('downloadBtn');
    if (!btn.disabled) btn.click();
  }
  if (e.key === 'Escape' && isDownloading) document.getElementById('cancelBtn').click();
});

// ── Download ──────────────────────────────────────────────────────────────────
document.getElementById('downloadBtn').addEventListener('click', async () => {
  const src = srcFiles();
  const toDownload = src.filter((_,i) => selectedIds.has(i));
  if (!toDownload.length) return;

  fileStatuses = {};
  setDownloading(true);
  const startTime = Date.now();
  let successCount = 0, failCount = 0;

  if (downloadMode === 'zip') {
    ({ successCount, failCount } = await runZipDownload(toDownload, src));
  } else {
    ({ successCount, failCount } = await runIndividualDownload(toDownload, src));
  }

  setDownloading(false);
  hideProgress();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({
    action: 'saveHistory',
    entry: {
      id: Date.now(),
      course: tab?.title?.slice(0, 80) || 'Unknown course',
      url: tab?.url || '',
      date: new Date().toISOString(),
      mode: downloadMode,
      total: toDownload.length,
      success: successCount,
      failed: failCount,
      duration: Math.round((Date.now() - startTime) / 1000),
    }
  });
  renderHistory();
});

// ── Individual downloads ──────────────────────────────────────────────────────
async function runIndividualDownload(files, fullSrc) {
  let done = 0, success = 0, fail = 0;
  for (const file of files) {
    showProgress((done / files.length) * 100,
      `Downloading ${done+1}/${files.length}: ${(file.resolvedName||file.name||'').slice(0,40)}…`);
    const filename = file.resolvedName || buildFallbackName(file);
    const result = await chrome.runtime.sendMessage({ action: 'download', url: file.url, filename });
    const idx = fullSrc.indexOf(file);
    if (result.error) { fileStatuses[idx] = 'error'; fail++; }
    else              { fileStatuses[idx] = 'done';  success++; }
    done++;
    renderFileList();
    await sleep(300);
  }
  showProgress(100, `✅ Done — ${success} downloaded${fail > 0 ? `, ${fail} failed` : ''}.`);
  await sleep(2200);
  return { successCount: success, failCount: fail };
}

// ── ZIP download ──────────────────────────────────────────────────────────────
async function runZipDownload(files, fullSrc) {
  if (typeof JSZip === 'undefined') {
    showProgress(0, '❌ JSZip not loaded. Check extension files.');
    await sleep(3000);
    return { successCount: 0, failCount: files.length };
  }

  const zip = new JSZip();
  const usedNames = {};
  let success = 0, fail = 0;

  const totalBytes = files.reduce((acc, f) => acc + (f.fileSize || 0), 0);
  if (totalBytes > 300 * 1024 * 1024) {
    showProgress(0, `⚠️ Large download (~${formatSize(totalBytes)}). This may take a while…`);
    await sleep(1500);
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    showProgress((i / files.length) * 80,
      `Fetching ${i+1}/${files.length}: ${(file.resolvedName||file.name||'').slice(0,40)}…`);

    const sessionId = 'zip-' + Date.now() + '-' + i;
    const result = await chrome.runtime.sendMessage({ action: 'fetchBase64', url: file.url, sessionId });
    const idx = fullSrc.indexOf(file);

    if (result.cancelled) {
      showProgress((i/files.length)*80, `⛔ Cancelled after ${i} file${i!==1?'s':''}.`);
      await sleep(1500);
      return { successCount: success, failCount: fail + (files.length - i) };
    }
    if (result.error) { fileStatuses[idx] = 'error'; fail++; renderFileList(); continue; }

    let fname = file.resolvedName || buildFallbackName(file);
    const subfolder = { docs:'Documents', video:'Videos', audio:'Audio', image:'Images' }[file.cat] || 'Other';
    const zipPath = subfolder + '/' + fname;
    const fullPath = usedNames[zipPath] !== undefined
      ? (() => {
          usedNames[zipPath]++;
          const dot = fname.lastIndexOf('.');
          const deduped = dot > 0
            ? fname.slice(0, dot) + ` (${usedNames[zipPath]})` + fname.slice(dot)
            : fname + ` (${usedNames[zipPath]})`;
          return subfolder + '/' + deduped;
        })()
      : (usedNames[zipPath] = 0, zipPath);

    const binary = atob(result.base64);
    const bytes = new Uint8Array(binary.length);
    for (let b = 0; b < binary.length; b++) bytes[b] = binary.charCodeAt(b);
    zip.file(fullPath, bytes);

    fileStatuses[idx] = 'done';
    success++;
    renderFileList();
  }

  showProgress(80, 'Compressing…');
  try {
    const blob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      meta => showProgress(80 + meta.percent * 0.19, `Compressing… ${Math.round(meta.percent)}%`)
    );
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const title = (tab?.title || 'moodle-materials')
      .replace(/[/\\:*?"<>|]/g, '').trim().replace(/\s+/g, '_').slice(0, 50);
    const objUrl = URL.createObjectURL(blob);
    await chrome.runtime.sendMessage({ action: 'download', url: objUrl, filename: title + '.zip' });
    showProgress(100, `✅ ZIP saved as "${title}.zip"`);
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
    window.addEventListener('unload', () => URL.revokeObjectURL(objUrl), { once: true });
    await sleep(2500);
  } catch(e) {
    showProgress(0, `❌ ZIP failed: ${e.message}`);
    await sleep(3000);
  }
  return { successCount: success, failCount: fail };
}

// ── Resolve filenames via background ─────────────────────────────────────────
async function resolveFilenames(files) {
  const banner = document.getElementById('resolvingBanner');
  const bannerText = document.getElementById('resolvingText');
  banner.style.display = 'flex';

  const hvpCount = files.filter(f => f.hvp).length;
  const folderCount = files.filter(f => f.folder).length;

  return new Promise(resolve => {
    let tick = 0;
    const interval = setInterval(() => {
      tick = Math.min(tick + 1, files.length);
      const extras = [];
      if (folderCount > 0) extras.push(`${folderCount} folder${folderCount > 1 ? 's' : ''}`);
      if (hvpCount > 0) extras.push(`${hvpCount} H5P video${hvpCount > 1 ? 's' : ''}`);
      const extraStr = extras.length ? ` · expanding ${extras.join(' & ')}` : '';
      bannerText.textContent = `Resolving${extraStr}… (${tick}/${files.length})`;
    }, 400);

    chrome.runtime.sendMessage({ action: 'resolveFilenames', files }, response => {
      clearInterval(interval);
      banner.style.display = 'none';
      const resolved = response?.files || files;
      resolve(resolved.filter(f => !f.hvpFailed));
    });
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));
    document.getElementById('panel-files').style.display   = activeTab === 'files'   ? 'block' : 'none';
    document.getElementById('panel-history').style.display = activeTab === 'history' ? 'block' : 'none';
    if (activeTab === 'history') renderHistory();
  });
});

document.getElementById('btnHistory').addEventListener('click', () => {
  document.querySelector('[data-tab="history"]')?.click();
  document.getElementById('mainTabs').style.display = 'flex';
});

// ── History ───────────────────────────────────────────────────────────────────
async function renderHistory() {
  const { history } = await chrome.runtime.sendMessage({ action: 'getHistory' });
  const listEl = document.getElementById('historyList');
  listEl.innerHTML = '';

  if (!history?.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No download history yet.';
    listEl.appendChild(empty);
    return;
  }

  history.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'history-item';
    const date = new Date(entry.date);
    const dateStr = date.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
    const timeStr = date.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });

    const top = document.createElement('div'); top.className = 'history-top';
    const title = document.createElement('div'); title.className = 'history-title';
    title.textContent = entry.course; title.title = entry.course;
    const dateEl = document.createElement('div'); dateEl.className = 'history-date';
    dateEl.textContent = dateStr + ' ' + timeStr;
    top.appendChild(title); top.appendChild(dateEl); item.appendChild(top);

    const meta = document.createElement('div'); meta.className = 'history-meta';
    meta.textContent = `${entry.mode === 'zip' ? 'ZIP' : 'Individual'} · ${entry.total} file${entry.total !== 1 ? 's' : ''}${entry.duration ? ` · ${entry.duration}s` : ''}`;
    item.appendChild(meta);

    const badges = document.createElement('div'); badges.className = 'history-badges';
    if (entry.success > 0) {
      const ok = document.createElement('span'); ok.className = 'hbadge hbadge-ok';
      ok.textContent = `✓ ${entry.success} ok`; badges.appendChild(ok);
    }
    if (entry.failed > 0) {
      const err = document.createElement('span'); err.className = 'hbadge hbadge-err';
      err.textContent = `✕ ${entry.failed} failed`; badges.appendChild(err);
    }
    item.appendChild(badges);
    listEl.appendChild(item);
  });
}

document.getElementById('clearHistory').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'clearHistory' });
  renderHistory();
});

document.getElementById('btnSettings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ── Rescan button (shown when serving from cache) ─────────────────────────────
document.getElementById('btnRescan').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await clearCache(tab.url);
  // Reset state
  allFiles = []; resolvedFiles = []; selectedIds.clear(); fileStatuses = {};
  document.getElementById('scanningState').style.display = 'flex';
  document.getElementById('panel-files').style.display = 'none';
  document.getElementById('mainTabs').style.display = 'none';
  await runScan(tab);
});

// ── Core scan + resolve ───────────────────────────────────────────────────────
async function runScan(tab) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
  const response = await chrome.tabs.sendMessage(tab.id, { action: 'scan' });
  allFiles = response?.files || [];

  document.getElementById('scanningState').style.display = 'none';
  document.getElementById('panel-files').style.display = 'block';
  document.getElementById('mainTabs').style.display = 'flex';
  document.getElementById('tabFilesBadge').textContent = allFiles.length;

  const headerSub = document.getElementById('headerSub');
  const courseName = (tab?.title || '').replace(/\s*[-|:]\s*Moodle.*/i, '').trim();
  headerSub.textContent = courseName || 'Moodle course';
  headerSub.title = tab?.url || '';

  if (!allFiles.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `<div class="emoji">📭</div>
      <p>No downloadable files found on this page.</p>
      <small>Make sure you're on a Moodle course page with resources.</small>`;
    document.getElementById('fileList').appendChild(empty);
    return;
  }

  // Show unresolved list immediately
  allFiles.forEach((_, i) => selectedIds.add(i));
  renderFilterBar();
  renderFileList();

  // Resolve in background
  const resolved = await resolveFilenames(allFiles);
  resolvedFiles = resolved;
  selectedIds.clear();
  resolvedFiles.forEach((_, i) => selectedIds.add(i));
  document.getElementById('tabFilesBadge').textContent = resolvedFiles.length;
  if (activeFilter === 'folder') activeFilter = 'all';
  renderFilterBar();
  renderFileList();

  // Cache the fully resolved list for this tab
  await setCache(tab.url, resolvedFiles);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // ── Cache hit: render instantly, no waiting ──
    const cached = await getCached(tab.url);
    if (cached && cached.length > 0) {
      resolvedFiles = cached;
      allFiles = cached;

      const headerSub = document.getElementById('headerSub');
      const courseName = (tab?.title || '').replace(/\s*[-|:]\s*Moodle.*/i, '').trim();
      headerSub.textContent = courseName || 'Moodle course';
      headerSub.title = tab?.url || '';

      // Show the cached indicator in the banner
      const banner = document.getElementById('resolvingBanner');
      const bannerText = document.getElementById('resolvingText');
      banner.style.display = 'flex';
      bannerText.textContent = `Loaded from cache · ${cached.length} files`;
      // Style banner differently for cache hit (no spinner needed)
      banner.querySelector('.spinner').style.display = 'none';
      setTimeout(() => { banner.style.display = 'none'; }, 2000);

      document.getElementById('scanningState').style.display = 'none';
      document.getElementById('panel-files').style.display = 'block';
      document.getElementById('mainTabs').style.display = 'flex';
      document.getElementById('tabFilesBadge').textContent = cached.length;

      cached.forEach((_, i) => selectedIds.add(i));
      renderFilterBar();
      renderFileList();
      return;
    }

    // ── Cache miss: full scan + resolve ──
    await runScan(tab);

  } catch(e) {
    document.getElementById('scanningState').innerHTML = `
      <div class="empty-state" style="padding:28px">
        <div class="emoji">⚠️</div>
        <p>Couldn't scan this page.</p>
        <small>Refresh the Moodle page and try again.</small>
      </div>`;
  }
}

init();