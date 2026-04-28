// popup.js

let allFiles = [];
let selectedIds = new Set();
let activeFilter = 'all';

const EXT_ORDER = ['pdf', 'pptx', 'ppt', 'docx', 'doc', 'txt', 'xlsx', 'xls', 'zip'];

function extClass(ext) {
  if (['pptx','ppt'].includes(ext)) return 'ext-pptx';
  if (['docx','doc'].includes(ext)) return 'ext-docx';
  if (['xlsx','xls'].includes(ext)) return 'ext-xlsx';
  return `ext-${ext}` ;
}

function getFilename(file) {
  try {
    const url = new URL(file.url);
    const pathname = url.pathname;
    const parts = pathname.split('/');
    const last = decodeURIComponent(parts[parts.length - 1]);
    if (last && last.includes('.')) return last;
  } catch(e) {}
  // fallback: slugify the name + ext
  const slug = file.name.replace(/[^a-zA-Z0-9\s\-_.]/g, '').trim().replace(/\s+/g, '_').slice(0, 60);
  return slug + (file.ext !== 'file' ? '.' + file.ext : '');
}

function renderFilterBar(files) {
  const bar = document.getElementById('filterBar');
  const extCounts = {};
  files.forEach(f => {
    extCounts[f.ext] = (extCounts[f.ext] || 0) + 1;
  });

  const btns = [{ label: `All (${files.length})`, value: 'all' }];
  EXT_ORDER.forEach(ext => {
    if (extCounts[ext]) {
      btns.push({ label: `${ext.toUpperCase()} (${extCounts[ext]})`, value: ext });
    }
  });
  // any other ext
  Object.keys(extCounts).forEach(ext => {
    if (!EXT_ORDER.includes(ext)) {
      btns.push({ label: `${ext.toUpperCase()} (${extCounts[ext]})`, value: ext });
    }
  });

  bar.innerHTML = btns.map(b =>
    `<button class="filter-btn ${b.value === activeFilter ? 'active' : ''}" data-filter="${b.value}">${b.label}</button>`
  ).join('');

  bar.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter;
      renderFilterBar(files);
      renderFileList();
    });
  });
}

function visibleFiles() {
  if (activeFilter === 'all') return allFiles;
  return allFiles.filter(f => f.ext === activeFilter);
}

function renderFileList() {
  const list = document.getElementById('fileList');
  const files = visibleFiles();

  if (files.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="emoji">🔍</div>
        <p>No files found on this page.</p>
        <small>Navigate to a Moodle course page and try again.</small>
      </div>`;
    updateFooter();
    return;
  }

  list.innerHTML = files.map((f, i) => {
    const id = allFiles.indexOf(f);
    const selected = selectedIds.has(id);
    return `
      <div class="file-item ${selected ? 'selected' : ''}" data-id="${id}">
        <div class="file-checkbox"></div>
        <span class="ext-badge ${extClass(f.ext)}">${f.ext}</span>
        <span class="file-name" title="${f.name}">${f.name || 'Unnamed file'}</span>
      </div>`;
  }).join('');

  list.querySelectorAll('.file-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = parseInt(item.dataset.id);
      if (selectedIds.has(id)) {
        selectedIds.delete(id);
        item.classList.remove('selected');
      } else {
        selectedIds.add(id);
        item.classList.add('selected');
      }
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
  if (toDownload.length === 0) return;

  const btn = document.getElementById('downloadBtn');
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const statusMsg = document.getElementById('statusMsg');

  btn.disabled = true;
  btn.textContent = '⬇ Downloading...';
  progressWrap.style.display = 'block';
  statusMsg.style.display = 'block';

  for (let i = 0; i < toDownload.length; i++) {
    const file = toDownload[i];
    statusMsg.textContent = `Downloading ${i + 1}/${toDownload.length}: ${file.name.slice(0, 40)}...`;
    progressFill.style.width = `${((i) / toDownload.length) * 100}%`;

    try {
      await chrome.downloads.download({
        url: file.url,
        filename: getFilename(file),
        conflictAction: 'uniquify'
      });
    } catch (e) {
      console.warn('Failed to download:', file.url, e);
    }

    // Small delay to avoid hammering the server
    await new Promise(r => setTimeout(r, 300));
  }

  progressFill.style.width = '100%';
  statusMsg.textContent = `✅ Done! ${toDownload.length} file${toDownload.length > 1 ? 's' : ''} sent to Downloads.`;
  btn.textContent = '⬇ Download';
  btn.disabled = false;
});

// Init: scan the active tab
async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Inject content script if needed
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    }).catch(() => {}); // ignore if already injected

    const response = await chrome.tabs.sendMessage(tab.id, { action: 'scan' });

    allFiles = response?.files || [];

    // Auto-select all
    allFiles.forEach((_, i) => selectedIds.add(i));

    document.getElementById('scanning-state').style.display = 'none';
    document.getElementById('main').style.display = 'block';

    if (allFiles.length === 0) {
      document.getElementById('filterBar').style.display = 'none';
      document.getElementById('fileList').innerHTML = `
        <div class="empty-state">
          <div class="emoji">📭</div>
          <p>No downloadable files found on this page.</p>
          <small>Make sure you're on a Moodle course page with resources listed.</small>
        </div>`;
      updateFooter();
    } else {
      renderFilterBar(allFiles);
      renderFileList();
    }
  } catch (e) {
    document.getElementById('scanning-state').innerHTML = `
      <div class="empty-state" style="padding:30px">
        <div class="emoji">⚠️</div>
        <p>Couldn't scan this page.</p>
        <small>Refresh the Moodle page and try again.</small>
      </div>`;
  }
}

init();
