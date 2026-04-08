/* ─── HostAI · app.js v2 ──────────────────────────────────────────────────── */

const API = '';
const $ = (id) => document.getElementById(id);

// DOM refs
const siteUrlInput     = $('site-url');
const deployUrlBtn     = $('deploy-url-btn');
const dropZone         = $('drop-zone');
const folderInput      = $('folder-input');
const fileInput         = $('file-input');
const browseBtn        = $('browse-btn');
const dropTitle        = $('drop-title');
const deployFilesBtn   = $('deploy-files-btn');
const fileTreeArea     = $('file-tree-area');
const fileTree         = $('file-tree');
const ftCount          = $('ft-count');
const clearFilesBtn    = $('clear-files-btn');
const mainFileSelect   = $('main-file-select');
const backendFileSelect= $('backend-file-select');
const toggleFolder     = $('toggle-folder');
const toggleFiles      = $('toggle-files');

const loadingCard      = $('loading-card');
const successCard      = $('success-card');
const errorCard        = $('error-card');
const loadingTitle     = $('loading-title');
const loadingSub       = $('loading-sub');
const errorMsg         = $('error-msg');
const scoreNum         = $('score-num');
const scoreBadge       = $('score-badge');
const siteUrlLink      = $('site-url-link');
const siteUrlDisplay   = $('site-url-display');
const copyUrlBtn       = $('copy-url-btn');
const impList          = $('imp-list');
const reportText       = $('report-text');
const visitBtn         = $('visit-btn');
const deployAnotherBtn = $('deploy-another-btn');
const tryAgainBtn      = $('try-again-btn');
const successSub       = $('success-sub');

const sitesGrid        = $('sites-grid');
const sitesEmpty       = $('sites-empty');
const refreshSitesBtn  = $('refresh-sites-btn');
const totalSitesCount  = $('total-sites-count');

const anTotal          = $('an-total');
const anAvgScore       = $('an-avg-score');
const anUrlCount       = $('an-url-count');
const anFileCount      = $('an-file-count');
const chartBars        = $('chart-bars');

const tunnelBadge      = $('tunnel-badge');
const tunnelStatus     = $('tunnel-status');
const publicUrlBar     = $('public-url-bar');
const publicBaseUrl    = $('public-base-url');
const copyBaseUrlBtn   = $('copy-base-url');

// STATE
let selectedFiles = [];
let selectedArchive = null;    // a single ZIP/RAR file
let uploadMode = 'folder';
let tunnelUrl = null;

// INIT
document.addEventListener('DOMContentLoaded', async () => {
  await checkStatus();
  await loadSites();
  bindEvents();
});

// ─── STATUS ───────────────────────────────────────────────────────────────────
async function checkStatus() {
  try {
    const res = await fetch(`${API}/api/status`);
    const data = await res.json();
    if (data.tunnel?.active && data.tunnel?.publicUrl) {
      tunnelUrl = data.tunnel.publicUrl;
      tunnelStatus.textContent = 'Public';
      tunnelBadge.querySelector('.pulse-dot').classList.remove('pulse-off');
      tunnelBadge.classList.add('tunnel-active');
      publicBaseUrl.textContent = tunnelUrl;
      publicBaseUrl.href = tunnelUrl;
      publicUrlBar.style.display = 'flex';
    } else {
      tunnelStatus.textContent = 'Local Only';
      tunnelBadge.querySelector('.pulse-dot').classList.add('pulse-off');
      publicUrlBar.style.display = 'none';
      setTimeout(checkStatus, 5000);
    }
  } catch {
    tunnelStatus.textContent = 'Offline';
    setTimeout(checkStatus, 5000);
  }
}

// ─── EVENTS ───────────────────────────────────────────────────────────────────
function bindEvents() {
  deployUrlBtn.addEventListener('click', handleDeployUrl);
  siteUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleDeployUrl(); });

  // Toggle upload mode
  toggleFolder.addEventListener('click', () => {
    uploadMode = 'folder';
    toggleFolder.classList.add('active');
    toggleFiles.classList.remove('active');
    dropTitle.textContent = 'Drop folder here or click to browse';
    browseBtn.textContent = 'Select Folder';
    clearAllFiles();
  });
  toggleFiles.addEventListener('click', () => {
    uploadMode = 'files';
    toggleFiles.classList.add('active');
    toggleFolder.classList.remove('active');
    dropTitle.textContent = 'Drop ZIP / RAR / files here';
    browseBtn.textContent = 'Select Files';
    clearAllFiles();
  });

  browseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (uploadMode === 'folder') folderInput.click();
    else fileInput.click();
  });
  dropZone.addEventListener('click', () => {
    if (uploadMode === 'folder') folderInput.click();
    else fileInput.click();
  });

  folderInput.addEventListener('change', () => {
    if (folderInput.files.length) handleSelectedFiles(Array.from(folderInput.files));
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleSelectedFiles(Array.from(fileInput.files));
  });

  // Drag & drop
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const items = e.dataTransfer.items;
    if (items && items.length > 0 && items[0].webkitGetAsEntry) {
      const entries = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      readEntriesRecursive(entries).then((files) => handleSelectedFiles(files));
    } else {
      handleSelectedFiles(Array.from(e.dataTransfer.files));
    }
  });

  deployFilesBtn.addEventListener('click', handleDeploy);
  clearFilesBtn.addEventListener('click', clearAllFiles);
  copyUrlBtn.addEventListener('click', copyUrl);
  deployAnotherBtn.addEventListener('click', resetAll);
  tryAgainBtn.addEventListener('click', resetAll);
  refreshSitesBtn.addEventListener('click', loadSites);

  copyBaseUrlBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(tunnelUrl);
      copyBaseUrlBtn.innerHTML = '✓';
      setTimeout(() => {
        copyBaseUrlBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg>`;
      }, 1500);
    } catch {}
  });

  document.querySelectorAll('.nav-pill').forEach((pill) => {
    pill.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelector(pill.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth' });
      document.querySelectorAll('.nav-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
    });
  });
}

// ─── READ DROPPED FOLDERS ─────────────────────────────────────────────────────
async function readEntriesRecursive(entries) {
  const files = [];
  async function processEntry(entry, prefix = '') {
    if (entry.isFile) {
      return new Promise((resolve) => {
        entry.file((file) => {
          file._relativePath = prefix + file.name;
          files.push(file);
          resolve();
        });
      });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const subEntries = await new Promise((resolve) => {
        const all = [];
        function readBatch() {
          reader.readEntries((batch) => {
            if (!batch.length) { resolve(all); return; }
            all.push(...batch);
            readBatch();
          });
        }
        readBatch();
      });
      for (const sub of subEntries) {
        await processEntry(sub, prefix + entry.name + '/');
      }
    }
  }
  for (const entry of entries) await processEntry(entry);
  return files;
}

// ─── FILE HANDLING ────────────────────────────────────────────────────────────
function handleSelectedFiles(files) {
  if (!files.length) return;

  // Check if it's a single archive file (ZIP/RAR)
  if (files.length === 1) {
    const name = files[0].name.toLowerCase();
    if (name.endsWith('.zip') || name.endsWith('.rar')) {
      handleArchiveFile(files[0]);
      return;
    }
  }

  selectedArchive = null;

  // Filter out junk
  selectedFiles = files.filter((f) => {
    const name = getRawRelPath(f);
    return !name.includes('node_modules/') && !name.startsWith('.') && !name.includes('/.');
  });

  applyPathCollisionGuard(selectedFiles);

  if (!selectedFiles.length) { dropTitle.textContent = 'No valid files found'; return; }

  // Show file tree
  fileTreeArea.classList.remove('hidden');
  dropZone.style.display = 'none';
  ftCount.textContent = `${selectedFiles.length.toLocaleString()} files`;

  fileTree.innerHTML = '';
  const maxShow = 30;
  const sorted = [...selectedFiles].sort((a, b) => getRelPath(a).localeCompare(getRelPath(b)));
  sorted.slice(0, maxShow).forEach((f) => {
    const rel = getRelPath(f);
    const ext = rel.split('.').pop().toLowerCase();
    const item = document.createElement('div');
    item.className = 'ft-item';
    item.innerHTML = `<span class="ft-icon">${getFileIcon(ext)}</span><span class="ft-path">${esc(rel)}</span><span class="ft-size">${fmtBytes(f.size)}</span>`;
    fileTree.appendChild(item);
  });
  if (selectedFiles.length > maxShow) {
    const more = document.createElement('div');
    more.className = 'ft-item ft-more';
    more.textContent = `... and ${(selectedFiles.length - maxShow).toLocaleString()} more files`;
    fileTree.appendChild(more);
  }

  populateFilePickers(sorted);
  deployFilesBtn.disabled = false;
  deployFilesBtn.textContent = selectedFiles.length > 200
    ? `Deploy Project (will ZIP ${selectedFiles.length.toLocaleString()} files)`
    : 'Deploy Project';
}

function handleArchiveFile(file) {
  selectedArchive = file;
  selectedFiles = [];

  fileTreeArea.classList.remove('hidden');
  dropZone.style.display = 'none';

  const ext = file.name.split('.').pop().toUpperCase();
  ftCount.textContent = `1 ${ext} archive`;

  fileTree.innerHTML = '';
  const item = document.createElement('div');
  item.className = 'ft-item';
  item.innerHTML = `<span class="ft-icon">📦</span><span class="ft-path">${esc(file.name)}</span><span class="ft-size">${fmtBytes(file.size)}</span>`;
  fileTree.appendChild(item);

  const info = document.createElement('div');
  info.className = 'ft-item ft-more';
  info.textContent = 'Archive will be extracted on server. Choose the main entry file below (any file type).';
  fileTree.appendChild(info);

  // Populate with common entry-point filenames + a custom option
  const commonNames = ['index.html', 'index.htm', 'app.js', 'server.js', 'main.js', 'index.js'];
  mainFileSelect.innerHTML =
    commonNames.map((n) => `<option value="${n}">${n}</option>`).join('') +
    '<option value="__custom__">Custom\u2026 (type below)</option>';
  mainFileSelect.value = 'index.html';

  // Show/hide a text input when Custom is chosen
  let customInput = document.getElementById('archive-main-custom');
  if (!customInput) {
    customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.id = 'archive-main-custom';
    customInput.className = 'picker-select';
    customInput.placeholder = 'e.g. my-backend.html, start.js';
    customInput.style.marginTop = '6px';
    mainFileSelect.parentNode.appendChild(customInput);
  }
  customInput.style.display = 'none';
  mainFileSelect.onchange = () => {
    customInput.style.display = mainFileSelect.value === '__custom__' ? 'block' : 'none';
  };

  backendFileSelect.innerHTML = '<option value="">None</option>';

  deployFilesBtn.disabled = false;
  deployFilesBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Deploy ${ext} Archive`;
}

function getRelPath(file) {
  if (file._hostaiPath) return file._hostaiPath;

  const p = file._relativePath || file.webkitRelativePath || file.name;
  // Strip top-level folder for webkitRelativePath
  if (file.webkitRelativePath && p.includes('/')) {
    return p.substring(p.indexOf('/') + 1);
  }
  return p;
}

function getRawRelPath(file) {
  return String(file._relativePath || file.webkitRelativePath || file.name || '').replace(/^\/+/, '');
}

function applyPathCollisionGuard(files) {
  if (!Array.isArray(files) || !files.length) return;

  const pathCounts = new Map();
  files.forEach((file) => {
    const rel = getRelPath(file);
    pathCounts.set(rel, (pathCounts.get(rel) || 0) + 1);
  });

  const hasCollision = [...pathCounts.values()].some((count) => count > 1);
  if (!hasCollision) return;

  files.forEach((file) => {
    file._hostaiPath = getRawRelPath(file);
  });
}

function populateFilePickers(files) {
  mainFileSelect.innerHTML = '';
  backendFileSelect.innerHTML = '<option value="">None</option>';

  // Categorize all files
  const htmlFiles = [];
  const jsFiles = [];
  const otherFiles = [];

  files.forEach((f) => {
    const rel = getRelPath(f);
    const ext = rel.split('.').pop().toLowerCase();
    if (['html', 'htm'].includes(ext)) htmlFiles.push(rel);
    else if (['js', 'mjs', 'ts', 'cjs'].includes(ext)) jsFiles.push(rel);
    else otherFiles.push(rel);
  });

  // Main file picker: ALL files, HTML first, then JS, then others
  const addOptGroup = (label, paths) => {
    if (!paths.length) return;
    const grp = document.createElement('optgroup');
    grp.label = label;
    paths.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      grp.appendChild(opt);
    });
    mainFileSelect.appendChild(grp);
  };

  if (htmlFiles.length || jsFiles.length || otherFiles.length) {
    addOptGroup('HTML Files', htmlFiles);
    addOptGroup('JavaScript Files', jsFiles);
    addOptGroup('Other Files', otherFiles);
  }

  // Smart default: prefer index.html → first html → first js → first file
  const allPaths = [...htmlFiles, ...jsFiles, ...otherFiles];
  const indexOpt = allPaths.find((p) => p.endsWith('index.html'));
  const firstHtml = htmlFiles[0];
  mainFileSelect.value = indexOpt || firstHtml || allPaths[0] || '';

  // Backend file picker: JS first, then all others (so any file can be a backend)
  const addBackendOptGroup = (label, paths) => {
    if (!paths.length) return;
    const grp = document.createElement('optgroup');
    grp.label = label;
    paths.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      grp.appendChild(opt);
    });
    backendFileSelect.appendChild(grp);
  };

  addBackendOptGroup('JavaScript Files', jsFiles);
  addBackendOptGroup('HTML Files', htmlFiles);
  addBackendOptGroup('Other Files', otherFiles);

  // Auto-select a likely server file
  const serverOpt = jsFiles.find((p) => /server\.|app\./.test(p));
  if (serverOpt) backendFileSelect.value = serverOpt;
}

function clearAllFiles() {
  selectedFiles = [];
  selectedArchive = null;
  folderInput.value = '';
  fileInput.value = '';
  fileTreeArea.classList.add('hidden');
  dropZone.style.display = 'flex';
  fileTree.innerHTML = '';
  mainFileSelect.innerHTML = '';
  mainFileSelect.onchange = null;
  // Remove archive custom input if present
  const customInp = document.getElementById('archive-main-custom');
  if (customInp) customInp.remove();
  backendFileSelect.innerHTML = '<option value="">None</option>';
  deployFilesBtn.disabled = true;
  deployFilesBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Deploy Project`;
  dropTitle.textContent = uploadMode === 'folder'
    ? 'Drop folder here or click to browse'
    : 'Drop ZIP / RAR / files here';
}

// Read the main file value whether it's from the select or the custom text input
function getMainFileValue() {
  if (mainFileSelect.value === '__custom__') {
    const c = document.getElementById('archive-main-custom');
    return (c && c.value.trim()) || 'index.html';
  }
  return mainFileSelect.value || 'index.html';
}

// ─── DEPLOY URL ───────────────────────────────────────────────────────────────
async function handleDeployUrl() {
  let url = siteUrlInput.value.trim();
  if (!url) { shakEl(siteUrlInput.closest('.input-wrapper')); return; }
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
  siteUrlInput.value = url;

  showLoading('Fetching site...', 'Connecting to URL');
  stepActive('ls-fetch');

  try {
    await delay(300);
    stepDone('ls-fetch'); stepActive('ls-ai');
    loadingTitle.textContent = 'AI Optimizing...';
    loadingSub.textContent = 'Analyzing performance';

    const res = await fetch(`${API}/api/deploy/url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    stepDone('ls-ai'); stepActive('ls-store');
    loadingTitle.textContent = 'Storing site...';
    await delay(200);

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Deploy failed');

    stepDone('ls-store'); stepActive('ls-url');
    await delay(300);
    stepDone('ls-url');

    showSuccess(data);
    await loadSites();
  } catch (err) {
    showError(err.message);
  }
}

// ─── DEPLOY FILES/ARCHIVE ─────────────────────────────────────────────────────
async function handleDeploy() {
  // Archive file (ZIP/RAR direct upload)
  if (selectedArchive) {
    return handleDeployArchive(selectedArchive);
  }

  // Folder with many files → ZIP client-side first
  if (selectedFiles.length > 100) {
    return handleDeployLargeFolder();
  }

  // Small set of files → upload directly
  return handleDeploySmallFiles();
}

async function handleDeployArchive(archiveFile) {
  const mainFile = getMainFileValue();
  const backendFile = backendFileSelect.value || '';

  showLoading('Uploading archive...', `${archiveFile.name} (${fmtBytes(archiveFile.size)})`);
  stepActive('ls-fetch');

  try {
    const formData = new FormData();
    formData.append('archive', archiveFile);
    formData.append('mainFile', mainFile);
    if (backendFile) formData.append('backendFile', backendFile);

    const res = await fetch(`${API}/api/deploy/archive`, {
      method: 'POST',
      body: formData,
    });

    stepDone('ls-fetch'); stepActive('ls-ai');
    loadingTitle.textContent = 'Extracting & optimizing...';
    loadingSub.textContent = 'Processing archive';

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Deploy failed');

    stepDone('ls-ai'); stepDone('ls-store'); stepDone('ls-url');
    showSuccess(data);
    await loadSites();
  } catch (err) {
    showError(err.message);
  }
}

async function handleDeployLargeFolder() {
  const mainFile = getMainFileValue();
  const backendFile = backendFileSelect.value || '';
  const fileCount = selectedFiles.length;

  showLoading('Zipping project...', `Packing ${fileCount.toLocaleString()} files in browser`);
  stepActive('ls-fetch');

  try {
    // Dynamically load JSZip if not loaded yet
    if (typeof JSZip === 'undefined') {
      loadingSub.textContent = 'Loading ZIP library...';
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    }

    // Create ZIP in browser
    const zip = new JSZip();
    let processed = 0;

    for (const file of selectedFiles) {
      const relPath = getRelPath(file);
      const arrayBuf = await file.arrayBuffer();
      zip.file(relPath, arrayBuf);
      processed++;
      if (processed % 500 === 0) {
        loadingSub.textContent = `Zipping... ${processed.toLocaleString()} / ${fileCount.toLocaleString()}`;
        await delay(1); // yield to UI
      }
    }

    loadingSub.textContent = 'Compressing...';
    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 3 }, // fast compression
    }, (meta) => {
      loadingSub.textContent = `Compressing... ${Math.round(meta.percent)}%`;
    });

    loadingTitle.textContent = 'Uploading ZIP...';
    loadingSub.textContent = `${fmtBytes(blob.size)} compressed`;

    const formData = new FormData();
    formData.append('archive', blob, 'project.zip');
    formData.append('mainFile', mainFile);
    if (backendFile) formData.append('backendFile', backendFile);

    stepDone('ls-fetch'); stepActive('ls-ai');

    const res = await fetch(`${API}/api/deploy/archive`, {
      method: 'POST',
      body: formData,
    });

    stepDone('ls-ai'); stepActive('ls-store');
    loadingTitle.textContent = 'Processing...';

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Deploy failed');

    stepDone('ls-store'); stepDone('ls-url');
    showSuccess(data);
    await loadSites();
  } catch (err) {
    showError(err.message);
  }
}

async function handleDeploySmallFiles() {
  const mainFile = getMainFileValue();
  const backendFile = backendFileSelect.value || '';

  showLoading('Uploading files...', `${selectedFiles.length} files`);
  stepActive('ls-fetch');

  try {
    const formData = new FormData();
    selectedFiles.forEach((f) => {
      const relPath = getRelPath(f);
      formData.append('files', f, relPath);
      // Send the full relative path (including subfolders) separately.
      // Multer strips directory separators from originalname for security,
      // so assets/index.js would be stored as index.js without this.
      formData.append('relativePaths', relPath);
    });
    formData.append('mainFile', mainFile);
    if (backendFile) formData.append('backendFile', backendFile);

    await delay(300);
    stepDone('ls-fetch'); stepActive('ls-ai');
    loadingTitle.textContent = 'AI Optimizing...';

    const res = await fetch(`${API}/api/deploy/files`, {
      method: 'POST',
      body: formData,
    });

    stepDone('ls-ai'); stepActive('ls-store');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Deploy failed');

    stepDone('ls-store'); stepDone('ls-url');
    showSuccess(data);
    await loadSites();
  } catch (err) {
    showError(err.message);
  }
}

// ─── LOAD SCRIPT DYNAMICALLY ──────────────────────────────────────────────────
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ZIP library'));
    document.head.appendChild(s);
  });
}

// ─── UI STATES ────────────────────────────────────────────────────────────────
function showLoading(title, sub) {
  hideAll();
  loadingTitle.textContent = title;
  loadingSub.textContent = sub;
  ['ls-fetch','ls-ai','ls-store','ls-url'].forEach((id) => {
    const el = $(id);
    el.classList.remove('active','done');
    el.querySelector('.ls-dot').className = 'ls-dot';
  });
  loadingCard.classList.remove('hidden');
  loadingCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  deployUrlBtn.disabled = true;
  deployFilesBtn.disabled = true;
}

function showSuccess(data) {
  hideAll();

  const score = data.score || 0;
  scoreNum.textContent = score;
  let scoreColor = 'linear-gradient(135deg, #ef4444, #dc2626)';
  if (score >= 80) scoreColor = 'linear-gradient(135deg, #10b981, #059669)';
  else if (score >= 60) scoreColor = 'linear-gradient(135deg, #f59e0b, #d97706)';
  else if (score >= 40) scoreColor = 'linear-gradient(135deg, #3b82f6, #2563eb)';
  scoreBadge.style.background = scoreColor;

  siteUrlLink.href = data.publicUrl;
  siteUrlDisplay.textContent = data.publicUrl;
  visitBtn.href = data.publicUrl;

  if (data.fileCount) {
    successSub.textContent = `${data.fileCount.toLocaleString()} files deployed`;
  }

  impList.innerHTML = '';
  (data.improvements || []).forEach((imp, i) => {
    const tag = document.createElement('span');
    tag.className = 'imp-tag';
    tag.style.animationDelay = `${i * 0.06}s`;
    tag.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg> ${esc(imp)}`;
    impList.appendChild(tag);
  });

  reportText.textContent = data.report || 'Deployment complete.';

  successCard.classList.remove('hidden');
  successCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  deployUrlBtn.disabled = false;
  deployFilesBtn.disabled = selectedFiles.length === 0 && !selectedArchive;
}

function showError(msg) {
  hideAll();
  errorMsg.textContent = msg;
  errorCard.classList.remove('hidden');
  errorCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  deployUrlBtn.disabled = false;
  deployFilesBtn.disabled = selectedFiles.length === 0 && !selectedArchive;
}

function hideAll() {
  loadingCard.classList.add('hidden');
  successCard.classList.add('hidden');
  errorCard.classList.add('hidden');
}

function resetAll() {
  hideAll();
  siteUrlInput.value = '';
  clearAllFiles();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function stepActive(id) {
  const el = $(id);
  el.classList.add('active');
  el.querySelector('.ls-dot').classList.add('active');
}
function stepDone(id) {
  const el = $(id);
  el.classList.remove('active');
  el.classList.add('done');
  const dot = el.querySelector('.ls-dot');
  dot.classList.remove('active');
  dot.classList.add('done');
}

// ─── COPY ─────────────────────────────────────────────────────────────────────
async function copyUrl() {
  try {
    await navigator.clipboard.writeText(siteUrlLink.href);
    copyUrlBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    copyUrlBtn.style.color = 'var(--c-success)';
    setTimeout(() => {
      copyUrlBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg>`;
      copyUrlBtn.style.color = '';
    }, 1800);
  } catch {}
}

// ─── SITES ────────────────────────────────────────────────────────────────────
async function loadSites() {
  try {
    const res = await fetch(`${API}/api/sites`);
    const data = await res.json();
    renderSites(data.sites || []);
    renderAnalytics(data.sites || []);
    totalSitesCount.textContent = (data.sites || []).length;
  } catch {}
}

function renderSites(sites) {
  sitesGrid.querySelectorAll('.site-card').forEach((c) => c.remove());
  if (!sites.length) { sitesEmpty.style.display = 'flex'; return; }
  sitesEmpty.style.display = 'none';

  sites.forEach((site, i) => {
    const card = document.createElement('div');
    card.className = 'site-card glass';
    card.style.animation = `fadeUp 0.4s ease ${i * 0.07}s both`;

    const mode = site.deployMode === 'url' ? 'URL' : `${(site.fileCount || 0).toLocaleString()} files`;
    const name = site.originalUrl
      ? new URL(site.originalUrl).hostname
      : (site.mainFile || site.siteId);
    const date = new Date(site.createdAt).toLocaleString();

    card.innerHTML = `
      <div class="sc-top">
        <div class="sc-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" stroke="currentColor" stroke-width="2"/></svg></div>
        <div>
          <div class="sc-name">${esc(name)}</div>
          <div class="sc-meta">${mode} · ${date}</div>
        </div>
        <div class="sc-score">${site.score || '--'}<span>/ 100</span></div>
      </div>
      <a href="${esc(site.publicUrl)}" class="sc-url" target="_blank">${esc(site.publicUrl)}</a>
      <div class="sc-actions">
        <a href="${esc(site.publicUrl)}" class="sc-btn sc-btn-visit" target="_blank">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" stroke="currentColor" stroke-width="2"/><polyline points="15 3 21 3 21 9" stroke="currentColor" stroke-width="2"/><line x1="10" y1="14" x2="21" y2="3" stroke="currentColor" stroke-width="2"/></svg>
          Visit
        </a>
        <button class="sc-btn sc-btn-delete" data-id="${site.siteId}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" stroke="currentColor" stroke-width="2"/></svg>
          Delete
        </button>
      </div>
    `;

    card.querySelector('.sc-btn-delete').addEventListener('click', async () => {
      if (!confirm('Delete this site?')) return;
      await fetch(`${API}/api/sites/${site.siteId}`, { method: 'DELETE' });
      card.remove();
      loadSites();
    });

    sitesGrid.appendChild(card);
  });
}

function renderAnalytics(sites) {
  anTotal.textContent = sites.length;
  anUrlCount.textContent = sites.filter((s) => s.deployMode === 'url').length;
  anFileCount.textContent = sites.filter((s) => s.deployMode !== 'url').length;
  const scores = sites.map((s) => s.score).filter(Boolean);
  anAvgScore.textContent = scores.length ? Math.round(scores.reduce((a, b) => a + b) / scores.length) : '--';

  chartBars.innerHTML = '';
  if (!sites.length) { chartBars.innerHTML = '<p class="chart-empty">Deploy sites to see scores</p>'; return; }
  sites.slice(0, 12).forEach((site) => {
    const name = site.originalUrl
      ? new URL(site.originalUrl).hostname.replace('www.', '')
      : (site.mainFile || site.siteId).substring(0, 10);
    const wrap = document.createElement('div');
    wrap.className = 'chart-bar-wrap';
    wrap.innerHTML = `
      <div class="chart-bar-val">${site.score || 0}</div>
      <div class="chart-bar" style="height:${Math.max(4, site.score || 0)}px"></div>
      <div class="chart-bar-label">${esc(name)}</div>
    `;
    chartBars.appendChild(wrap);
  });
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(1)} GB`;
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function shakEl(el) {
  el.style.animation = 'none'; el.offsetHeight;
  el.style.animation = 'shake 0.35s ease';
  el.addEventListener('animationend', () => { el.style.animation = ''; }, { once: true });
}
function getFileIcon(ext) {
  const icons = {
    html: '🌐', htm: '🌐', css: '🎨', js: '⚡', ts: '💎', jsx: '⚛️', tsx: '⚛️',
    json: '📋', md: '📝', txt: '📄', xml: '📄', svg: '🖼️',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', ico: '🖼️',
    zip: '📦', rar: '📦', woff: '🔤', woff2: '🔤', ttf: '🔤',
  };
  return icons[ext] || '📄';
}

const shakeStyle = document.createElement('style');
shakeStyle.textContent = `@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}`;
document.head.appendChild(shakeStyle);
