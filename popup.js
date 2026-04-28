// popup.js - Moodle Bulk Downloader v3

let allFiles = [];        // raw files from content scan
let resolvedFiles = [];   // files with resolvedName filled in
let selectedIds = new Set();
let activeFilter = 'all';
let downloadMode = 'individual'; // 'individual' | 'zip'
let isDownloading = false;

// ── Category config ───────────────────────────────────────────────────────────
const CATEGORIES = [
  { id: 'all',   label: 'All',    icon: '📦' },
  { id: 'docs',  label: 'Docs',   icon: '📄' },
  { id: 'video', label: 'Videos', icon: '🎬' },
  { id: 'audio', label: 'Audio',  icon: '🎵' },
  { id: 'image', label: 'Images', icon: '🖼️' },
];

// ── Badge colours ─────────────────────────────────────────────────────────────
const EXT_STYLE = {
  pdf:  { bg:'#3b1515', color:'#f87171' },
  docx: { bg:'#132240', color:'#60a5fa' },
  pptx: { bg:'#2d1a0e', color:'#fb923c' },
  xlsx: { bg:'#0f2a1e', color:'#34d399' },
  txt:  { bg:'#1a2e1a', color:'#86efac' },
  zip:  { bg:'#2a1f3a', color:'#c084fc' },
  mp4:  { bg:'#1f1a3a', color:'#a78bfa' },
  mp3:  { bg:'#1a2535', color:'#67e8f9' },
  img:  { bg:'#2a1a1a', color:'#fca5a5' },
  file: { bg:'#1e2535', color:'#9ca3af' },
};
function badgeStyle(ext) {
  const s = EXT_STYLE[ext] || EXT_STYLE.file;
  return `background:${s.bg};color:${s.color}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function visibleFiles() {
  const src = resolvedFiles.length ? resolvedFiles : allFiles;
  if (activeFilter === 'all') return src;
  return src.filter(f => f.cat === activeFilter);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Filter bar ────────────────────────────────────────────────────────────────
function renderFilterBar() {
  const bar = document.getElementById('filterBar');
  const counts = { all: allFiles.length };
  allFiles.forEach(f => { counts[f.cat] = (counts[f.cat] || 0) + 1; });

  bar.innerHTML = CATEGORIES
      .filter(c => c.id === 'all' || counts[c.id])
      .map(c => {
        const active = activeFilter === c.id ? 'active' : '';
        return `<button class="filter-btn ${active}" data-filter="${c.id}">
        ${c.icon} ${c.label} <span class="filter-count">${counts[c.id] || 0}</span>
      </button>`;
      }).join('');

  bar.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter;
      renderFilterBar();
      renderFileList();
    });
  });
}

// ── File list ─────────────────────────────────────────────────────────────────
function renderFileList() {
  const list = document.getElementById('fileList');
  const files = visibleFiles();

  if (!files.length) {
    list.innerHTML = `<div class="empty-state"><div class="emoji">📭</div><p>No files in this category.</p></div>`;
    updateFooter();
    return;
  }

  const stillResolving = resolvedFiles.length === 0;

  list.innerHTML = files.map(f => {
    const id = allFiles.findIndex(x => x === (resolvedFiles.length ? resolvedFiles[allFiles.indexOf(f)] : f));
    // map back to index in allFiles
    const idx = resolvedFiles.length
        ? resolvedFiles.indexOf(f)
        : allFiles.indexOf(f);
    const selected = selectedIds.has(idx);
    const displayName = f.resolvedName || f.name || 'Unnamed';
    const nameClass = f.resolvedName ? 'resolved' : (stillResolving ? 'resolving' : '');
    return `
      <div class="file-item ${selected ? 'selected' : ''}" data-idx="${idx}">
        <div class="file-checkbox">${selected ? '✓' : ''}</div>
        <span class="ext-badge" style="${badgeStyle(f.ext)}">${f.label || f.ext.toUpperCase()}</span>
        <span class="file-name ${nameClass}" title="${displayName}">${displayName}</span>
      </div>`;
  }).join('');

  list.querySelectorAll('.file-item').forEach(item => {
    item.addEventListener('click', () => {
      if (isDownloading) return;
      const idx = parseInt(item.dataset.idx);
      if (selectedIds.has(idx)) selectedIds.delete(idx);
      else selectedIds.add(idx);
      renderFileList();
      updateFooter();
    });
  });

  updateFooter();
}

// ── Footer ────────────────────────────────────────────────────────────────────
function updateFooter() {
  const btn = document.getElementById('downloadBtn');
  const label = document.getElementById('countLabel');
  const selAll = document.getElementById('selectAll');
  const cancelBtn = document.getElementById('cancelBtn');

  label.textContent = selectedIds.size > 0 ? `${selectedIds.size} selected` : '';
  btn.disabled = selectedIds.size === 0 || isDownloading;

  const vis = visibleFiles();
  const allVisSelected = vis.length > 0 && vis.every((_, i) => {
    const idx = resolvedFiles.length ? resolvedFiles.indexOf(vis[i]) : allFiles.indexOf(vis[i]);
    return selectedIds.has(idx);
  });
  selAll.textContent = allVisSelected ? 'Deselect all' : 'Select all';
  selAll.style.pointerEvents = isDownloading ? 'none' : '';

  cancelBtn.style.display = isDownloading ? 'block' : 'none';
  btn.textContent = downloadMode === 'zip' ? '🗜 Download ZIP' : '⬇ Download';
}

// ── Select all ────────────────────────────────────────────────────────────────
document.getElementById('selectAll').addEventListener('click', () => {
  if (isDownloading) return;
  const src = resolvedFiles.length ? resolvedFiles : allFiles;
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
  // UI will reset from the download loop detecting cancellation
});

// ── Progress helpers ──────────────────────────────────────────────────────────
function showProgress(pct, msg) {
  document.getElementById('progressArea').style.display = 'block';
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('statusMsg').textContent = msg;
}
function hideProgress() {
  document.getElementById('progressArea').style.display = 'none';
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('statusMsg').textContent = '';
}
function setDownloading(val) {
  isDownloading = val;
  updateFooter();
}

// ── Download button ───────────────────────────────────────────────────────────
document.getElementById('downloadBtn').addEventListener('click', async () => {
  const src = resolvedFiles.length ? resolvedFiles : allFiles;
  const toDownload = src.filter((_, i) => selectedIds.has(i));
  if (!toDownload.length) return;

  setDownloading(true);

  if (downloadMode === 'zip') {
    await runZipDownload(toDownload);
  } else {
    await runIndividualDownload(toDownload);
  }

  setDownloading(false);
  hideProgress();
});

// ── Individual downloads ──────────────────────────────────────────────────────
async function runIndividualDownload(files) {
  let done = 0;
  for (const file of files) {
    // Check cancel
    const { cancelled } = await chrome.runtime.sendMessage({ action: 'checkCancel' });
    if (cancelled) {
      showProgress((done / files.length) * 100, `⛔ Cancelled after ${done} file${done !== 1 ? 's' : ''}.`);
      await sleep(1500);
      return;
    }

    showProgress((done / files.length) * 100,
        `Downloading ${done + 1}/${files.length}: ${(file.resolvedName || file.name).slice(0, 42)}…`);

    const filename = file.resolvedName || buildFallbackName(file);

    await chrome.runtime.sendMessage({
      action: 'download',
      url: file.url,
      filename
    });

    done++;
    await sleep(350);
  }
  showProgress(100, `✅ Done! ${done} file${done !== 1 ? 's' : ''} sent to Downloads.`);
  await sleep(2000);
}

// ── ZIP download ──────────────────────────────────────────────────────────────
async function runZipDownload(files) {
  showProgress(0, `Fetching ${files.length} file${files.length !== 1 ? 's' : ''}…`);

  // Poll zip progress from storage while background builds
  const pollInterval = setInterval(async () => {
    const data = await chrome.storage.session.get('zipProgress');
    const p = data.zipProgress;
    if (!p) return;
    if (p.phase === 'fetch') {
      const pct = Math.round((p.current / p.total) * 80);
      showProgress(pct, `Fetching ${p.current + 1}/${p.total}: ${(p.name || '').slice(0, 40)}…`);
    } else if (p.phase === 'compress') {
      const pct = 80 + Math.round((p.percent || 0) * 0.2);
      showProgress(pct, `Compressing… ${Math.round(p.percent || 0)}%`);
    }
  }, 300);

  const courseName = document.title || 'moodle-materials';
  const zipName = courseName.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim().replace(/\s+/g, '_').slice(0, 50) + '.zip';

  const result = await chrome.runtime.sendMessage({
    action: 'buildZip',
    files,
    zipName
  });

  clearInterval(pollInterval);
  await chrome.storage.session.remove('zipProgress');

  if (result.cancelled) {
    showProgress(0, '⛔ Cancelled.');
    await sleep(1500);
    return;
  }
  if (result.error) {
    showProgress(0, `❌ Error: ${result.error}`);
    await sleep(2500);
    return;
  }

  // Trigger download of the base64 ZIP
  showProgress(100, 'Saving ZIP…');
  const dataUrl = `data:application/zip;base64,${result.base64}`;
  await chrome.runtime.sendMessage({
    action: 'download',
    url: dataUrl,
    filename: result.zipName
  });
  showProgress(100, `✅ ZIP saved as "${result.zipName}"`);
  await sleep(2500);
}

// ── Fallback filename builder ─────────────────────────────────────────────────
function buildFallbackName(file) {
  const slug = (file.name || 'file').replace(/[^a-zA-Z0-9\s\-_.]/g, '').trim().replace(/\s+/g, '_').slice(0, 60);
  const ext = file.ext && file.ext !== 'file' && file.ext !== 'img' ? '.' + file.ext : '';
  return slug + ext;
}

// ── Resolve real filenames via background HEAD requests ───────────────────────
async function resolveFilenames(files) {
  const banner = document.getElementById('resolvingBanner');
  const bannerText = document.getElementById('resolvingText');
  banner.style.display = 'flex';

  return new Promise((resolve) => {
    let completed = 0;
    const results = [...files];

    // Send all at once — background resolves in parallel
    chrome.runtime.sendMessage(
        { action: 'resolveFilenames', files },
        (response) => {
          banner.style.display = 'none';
          if (response?.files) {
            resolve(response.files);
          } else {
            resolve(files); // fallback to original
          }
        }
    );

    // Update banner text with a simple counter while waiting
    const interval = setInterval(() => {
      completed = Math.min(completed + 1, files.length - 1);
      bannerText.textContent = `Resolving file names… (${completed}/${files.length})`;
    }, 300);

    // Clear interval when message resolves (we rely on callback above)
    // The interval will self-clear when banner is hidden
    setTimeout(() => clearInterval(interval), files.length * 600 + 2000);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({ target:{ tabId: tab.id }, files:['content.js'] }).catch(() => {});

    const response = await chrome.tabs.sendMessage(tab.id, { action: 'scan' });
    allFiles = response?.files || [];
    allFiles.forEach((_, i) => selectedIds.add(i));

    document.getElementById('scanning-state').style.display = 'none';
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

    // Resolve real filenames in background (non-blocking render)
    resolveFilenames(allFiles).then(resolved => {
      resolvedFiles = resolved;
      renderFileList();
    });

  } catch(e) {
    document.getElementById('scanning-state').innerHTML = `
      <div class="empty-state" style="padding:28px">
        <div class="emoji">⚠️</div>
        <p>Couldn't scan this page.</p>
        <small>Refresh the Moodle page and try again.</small>
      </div>`;
  }
}

init();
