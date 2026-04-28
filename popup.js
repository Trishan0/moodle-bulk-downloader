// popup.js - v2

let allFiles = [];
let selectedIds = new Set();
let activeFilter = 'all';

// Category config
const CATEGORIES = [
  { id: 'all',   label: 'All',      icon: '📦' },
  { id: 'docs',  label: 'Docs',     icon: '📄' },
  { id: 'video', label: 'Videos',   icon: '🎬' },
  { id: 'audio', label: 'Audio',    icon: '🎵' },
  { id: 'image', label: 'Images',   icon: '🖼️' },
];

// Badge styling per ext
const EXT_STYLE = {
  pdf:   { bg: '#3b1515', color: '#f87171' },
  docx:  { bg: '#132240', color: '#60a5fa' },
  pptx:  { bg: '#2d1a0e', color: '#fb923c' },
  xlsx:  { bg: '#0f2a1e', color: '#34d399' },
  txt:   { bg: '#1a2e1a', color: '#86efac' },
  zip:   { bg: '#2a1f3a', color: '#c084fc' },
  mp4:   { bg: '#1f1a3a', color: '#a78bfa' },
  mp3:   { bg: '#1a2535', color: '#67e8f9' },
  img:   { bg: '#2a1a1a', color: '#fca5a5' },
  file:  { bg: '#1e2535', color: '#9ca3af' },
};

function badgeStyle(ext) {
  const s = EXT_STYLE[ext] || EXT_STYLE.file;
  return `background:${s.bg};color:${s.color}`;
}

function visibleFiles() {
  if (activeFilter === 'all') return allFiles;
  return allFiles.filter(f => f.cat === activeFilter);
}

function getFilename(file) {
  try {
    const url = new URL(file.url);
    const parts = url.pathname.split('/');
    const last = decodeURIComponent(parts[parts.length - 1]);
    if (last && last.includes('.')) return last;
  } catch(e) {}
  const slug = file.name.replace(/[^a-zA-Z0-9\s\-_.]/g, '').trim().replace(/\s+/g, '_').slice(0, 60);
  return slug + (file.ext && file.ext !== 'file' ? '.' + file.ext : '');
}

function renderFilterBar() {
  const bar = document.getElementById('filterBar');
  const counts = { all: allFiles.length };
  allFiles.forEach(f => { counts[f.cat] = (counts[f.cat] || 0) + 1; });

  bar.innerHTML = CATEGORIES
      .filter(c => c.id === 'all' || counts[c.id])
      .map(c => {
        const count = counts[c.id] || 0;
        const active = activeFilter === c.id ? 'active' : '';
        return `<button class="filter-btn ${active}" data-filter="${c.id}">
        ${c.icon} ${c.label} <span class="filter-count">${count}</span>
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

function renderFileList() {
  const list = document.getElementById('fileList');
  const files = visibleFiles();

  if (files.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="emoji">📭</div>
        <p>No files in this category.</p>
      </div>`;
    updateFooter();
    return;
  }

  list.innerHTML = files.map(f => {
    const id = allFiles.indexOf(f);
    const selected = selectedIds.has(id);
    return `
      <div class="file-item ${selected ? 'selected' : ''}" data-id="${id}">
        <div class="file-checkbox">${selected ? '✓' : ''}</div>
        <span class="ext-badge" style="${badgeStyle(f.ext)}">${f.label || f.ext.toUpperCase()}</span>
        <span class="file-name" title="${f.name}">${f.name || 'Unnamed file'}</span>
      </div>`;
  }).join('');

  list.querySelectorAll('.file-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = parseInt(item.dataset.id);
      if (selectedIds.has(id)) {
        selectedIds.delete(id);
      } else {
        selectedIds.add(id);
      }
      renderFileList();
      updateFooter();
    });
  });

  updateFooter();
}

function updateFooter() {
  const btn = document.getElementById('downloadBtn');
  const label = document.getElementById('countLabel');
  const selAll = document.getElementById('selectAll');

  const count = selectedIds.size;
  label.textContent = count > 0 ? `${count} selected` : '';
  btn.disabled = count === 0;

  const vis = visibleFiles();
  const allVisSelected = vis.length > 0 && vis.every(f => selectedIds.has(allFiles.indexOf(f)));
  selAll.textContent = allVisSelected ? 'Deselect all' : 'Select all';
}

document.getElementById('selectAll').addEventListener('click', () => {
  const vis = visibleFiles();
  const allVisSelected = vis.every(f => selectedIds.has(allFiles.indexOf(f)));
  if (allVisSelected) {
    vis.forEach(f => selectedIds.delete(allFiles.indexOf(f)));
  } else {
    vis.forEach(f => selectedIds.add(allFiles.indexOf(f)));
  }
  renderFileList();
});

document.getElementById('downloadBtn').addEventListener('click', async () => {
  const toDownload = allFiles.filter((_, i) => selectedIds.has(i));
  if (!toDownload.length) return;

  const btn = document.getElementById('downloadBtn');
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const statusMsg = document.getElementById('statusMsg');

  btn.disabled = true;
  btn.innerHTML = '⬇ Downloading...';
  progressWrap.style.display = 'block';
  statusMsg.style.display = 'block';

  let done = 0;
  for (const file of toDownload) {
    statusMsg.textContent = `Downloading ${done + 1}/${toDownload.length}: ${file.name.slice(0, 38)}…`;
    progressFill.style.width = `${(done / toDownload.length) * 100}%`;
    try {
      await chrome.downloads.download({
        url: file.url,
        filename: getFilename(file),
        conflictAction: 'uniquify'
      });
    } catch(e) {
      console.warn('Download failed:', file.url, e);
    }
    done++;
    await new Promise(r => setTimeout(r, 350));
  }

  progressFill.style.width = '100%';
  statusMsg.textContent = `✅ Done! ${done} file${done !== 1 ? 's' : ''} sent to Downloads.`;
  btn.innerHTML = '⬇ Download';
  btn.disabled = false;
});

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});

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
    } else {
      renderFilterBar();
      renderFileList();
    }
  } catch(e) {
    document.getElementById('scanning-state').innerHTML = `
      <div class="empty-state" style="padding:30px">
        <div class="emoji">⚠️</div>
        <p>Couldn't scan this page.</p>
        <small>Refresh the Moodle page and try again.</small>
      </div>`;
  }
}

init();
