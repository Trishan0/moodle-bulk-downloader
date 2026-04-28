// content.js - Scans the Moodle page for downloadable files

const FILE_EXTENSIONS = ['pdf', 'docx', 'doc', 'pptx', 'ppt', 'txt', 'xlsx', 'xls', 'zip'];

function getFileExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split('.');
    if (parts.length > 1) {
      return parts[parts.length - 1].toLowerCase();
    }
  } catch (e) {}
  return null;
}

function isMoodleFileLink(anchor) {
  const href = anchor.href || '';
  // Moodle resource/mod/resource links
  if (href.includes('/mod/resource/view.php') || href.includes('/pluginfile.php')) {
    return true;
  }
  // Direct file extension in URL
  const ext = getFileExtension(href);
  if (ext && FILE_EXTENSIONS.includes(ext)) {
    return true;
  }
  // Check surrounding context for file icons (Moodle adds these)
  const parent = anchor.closest('li.activity') || anchor.closest('.activityinstance') || anchor.parentElement;
  if (parent) {
    const classes = parent.className || '';
    if (classes.includes('resource') || classes.includes('pdf') || classes.includes('document')) {
      return true;
    }
    // Check for file type icons in the link
    const img = anchor.querySelector('img');
    if (img) {
      const src = img.src || '';
      if (FILE_EXTENSIONS.some(ext => src.includes(ext))) {
        return true;
      }
    }
  }
  return false;
}

function getLinkLabel(anchor) {
  // Try to get a clean name
  const spanTitle = anchor.querySelector('.instancename, .fp-filename, span');
  if (spanTitle) {
    return spanTitle.textContent.trim().replace(/\s+/g, ' ');
  }
  return anchor.textContent.trim().replace(/\s+/g, ' ') || anchor.href;
}

function scanForFiles() {
  const anchors = document.querySelectorAll('a[href]');
  const found = [];
  const seen = new Set();

  anchors.forEach(anchor => {
    const href = anchor.href;
    if (!href || seen.has(href)) return;
    if (href.startsWith('javascript:') || href.startsWith('mailto:')) return;

    if (isMoodleFileLink(anchor)) {
      seen.add(href);
      const ext = getFileExtension(href) || 'file';
      found.push({
        url: href,
        name: getLinkLabel(anchor),
        ext: ext
      });
    }
  });

  return found;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'scan') {
    const files = scanForFiles();
    sendResponse({ files });
  }
  return true;
});
