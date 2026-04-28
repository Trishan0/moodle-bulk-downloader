# Moodle Bulk Downloader 📦

A Chrome/Edge browser extension to download all study materials from a Moodle course page in one click.

## Supported file types
PDF, DOCX, DOC, PPTX, PPT, TXT, XLSX, XLS, ZIP

---

## Installation (Chrome / Edge)

1. Open your browser and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select the `moodle-bulk-downloader` folder
5. The extension icon will appear in your toolbar

> **Firefox users**: Go to `about:debugging` → "This Firefox" → "Load Temporary Add-on" → select `manifest.json`

---

## How to use

1. Navigate to your **Moodle course page** (the one listing all resources/activities)
2. Click the extension icon in the toolbar
3. It will scan the page and list all downloadable files
4. Use the filter buttons to show only PDFs, PPTXs, etc.
5. Click individual files to select/deselect, or use **"Select all"**
6. Click **Download** — all files go to your Downloads folder

---

## Tips

- If some files are behind a login redirect, make sure you're already logged in to Moodle before using the extension
- Downloads go to your default browser Downloads folder
- The extension adds a small 300ms delay between files to be polite to the server
- File names are taken from the URL or the link text on the page

---

## Troubleshooting

**No files found?**
- Make sure you're on the main course page that lists all activities (not inside a quiz or forum)
- Some Moodle setups require you to click into the resource section first

**Download fails for some files?**
- Those files may require re-authentication — try opening them manually once to refresh your session
