// content.js - Moodle Bulk Downloader v2

const ICON_MAP = [
  { keys: ['pdf'],                                                    ext: 'pdf',   cat: 'docs',  label: 'PDF' },
  { keys: ['word', 'docx', 'doc', 'writer', 'odt'],                 ext: 'docx',  cat: 'docs',  label: 'Word' },
  { keys: ['powerpoint', 'pptx', 'ppt', 'impress', 'presentation'], ext: 'pptx',  cat: 'docs',  label: 'PPT' },
  { keys: ['excel', 'xlsx', 'xls', 'calc', 'spreadsheet'],          ext: 'xlsx',  cat: 'docs',  label: 'Excel' },
  { keys: ['text', 'txt', 'plain'],                                  ext: 'txt',   cat: 'docs',  label: 'TXT' },
  { keys: ['zip', 'archive', 'rar', '7z', 'tar', 'gz'],             ext: 'zip',   cat: 'docs',  label: 'ZIP' },
  { keys: ['video', 'mpeg', 'mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'quicktime'],
    ext: 'mp4',   cat: 'video', label: 'Video' },
  { keys: ['audio', 'mp3', 'wav', 'ogg', 'aac', 'flac'],           ext: 'mp3',   cat: 'audio', label: 'Audio' },
  { keys: ['image', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'bmp'],    ext: 'img',   cat: 'image', label: 'Image' },
];

const MOD_SKIP = [
  '/mod/url/', '/mod/forum/', '/mod/quiz/', '/mod/assign/',
  '/mod/feedback/', '/mod/chat/', '/mod/choice/', '/mod/survey/',
  '/mod/wiki/', '/mod/glossary/', '/mod/workshop/', '/mod/lesson/',
  '/mod/scorm/', '/mod/lti/'
];

function detectFromStr(str) {
  if (!str) return null;
  const lower = str.toLowerCase();
  for (const entry of ICON_MAP) {
    if (entry.keys.some(k => lower.includes(k))) return entry;
  }
  return null;
}

function detectFromUrl(url) {
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

function getLinkLabel(anchor) {
  const instancename = anchor.querySelector('.instancename');
  if (instancename) {
    const clone = instancename.cloneNode(true);
    clone.querySelectorAll('.accesshide, .hide').forEach(el => el.remove());
    const text = clone.textContent.trim().replace(/\s+/g, ' ');
    if (text) return text;
  }
  const fp = anchor.querySelector('.fp-filename');
  if (fp) return fp.textContent.trim();
  return anchor.textContent.trim().replace(/\s+/g, ' ') || 'Unnamed';
}

function shouldSkip(href) {
  if (!href || href.startsWith('javascript:') || href.startsWith('mailto:')) return true;
  if (href.includes('course/mod.php') || href.includes('action=')) return true;
  if (MOD_SKIP.some(p => href.includes(p))) return true;
  return false;
}

function resolveTypeForActivity(li, href) {
  // Try every img on the activity item
  const imgs = li.querySelectorAll('img');
  for (const img of imgs) {
    const t = detectFromStr(img.src) || detectFromStr(img.alt) || detectFromStr(img.className);
    if (t) return t;
  }
  // Try URL
  const t = detectFromUrl(href);
  if (t) return t;
  // li class hints
  const liClass = li.className;
  if (liClass.includes('resource')) return { ext: 'file', cat: 'docs', label: 'File' };
  return null;
}

function scanForFiles() {
  const found = [];
  const seen = new Set();

  // Strategy 1: Moodle li.activity items
  document.querySelectorAll('li.activity').forEach(li => {
    const anchor = li.querySelector('a[href]');
    if (!anchor) return;
    const href = anchor.href;
    if (seen.has(href) || shouldSkip(href)) return;

    const typeInfo = resolveTypeForActivity(li, href);
    if (!typeInfo) return;

    seen.add(href);
    found.push({ url: href, name: getLinkLabel(anchor), ...typeInfo });
  });

  // Strategy 2: pluginfile.php direct links
  document.querySelectorAll('a[href*="pluginfile.php"]').forEach(anchor => {
    const href = anchor.href;
    if (seen.has(href) || shouldSkip(href)) return;
    const typeInfo = detectFromUrl(href)
        || detectFromStr((anchor.querySelector('img') || {}).src)
        || { ext: 'file', cat: 'docs', label: 'File' };
    seen.add(href);
    found.push({ url: href, name: getLinkLabel(anchor), ...typeInfo });
  });

  // Strategy 3: remaining /mod/resource/ links
  document.querySelectorAll('a[href*="/mod/resource/view.php"]').forEach(anchor => {
    const href = anchor.href;
    if (seen.has(href) || shouldSkip(href)) return;
    const container = anchor.closest('li, div, td');
    const imgs = container ? container.querySelectorAll('img') : [];
    let typeInfo = null;
    for (const img of imgs) {
      typeInfo = detectFromStr(img.src) || detectFromStr(img.alt);
      if (typeInfo) break;
    }
    typeInfo = typeInfo || { ext: 'file', cat: 'docs', label: 'File' };
    seen.add(href);
    found.push({ url: href, name: getLinkLabel(anchor), ...typeInfo });
  });

  return found;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'scan') {
    sendResponse({ files: scanForFiles() });
  }
  return true;
});
