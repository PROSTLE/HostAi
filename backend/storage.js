import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITES_DIR = path.join(__dirname, '..', 'sites');
const SITE_ID_REGEX = /^[a-f0-9]{12}$/;

if (!fs.existsSync(SITES_DIR)) fs.mkdirSync(SITES_DIR, { recursive: true });

function normalizeProjectPath(inputPath) {
  if (typeof inputPath !== 'string') return null;
  const normalized = inputPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const safe = path.posix.normalize(normalized);
  if (!safe || safe === '.' || safe.startsWith('..') || path.posix.isAbsolute(safe)) return null;
  return safe;
}

export function isValidSiteId(siteId) {
  return typeof siteId === 'string' && SITE_ID_REGEX.test(siteId);
}

function resolveSiteDirectory(siteId) {
  if (!isValidSiteId(siteId)) return null;

  const sitesRoot = path.resolve(SITES_DIR);
  const siteDir = path.resolve(path.join(SITES_DIR, siteId));
  if (!siteDir.startsWith(sitesRoot + path.sep)) return null;
  return siteDir;
}

export function generateSiteId() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Save an entire project (multiple files) to storage
 */
export async function saveSiteProject(siteId, filesMap, metadata = {}) {
  const siteDir = resolveSiteDirectory(siteId);
  if (!siteDir) {
    throw new Error('Invalid siteId');
  }

  fs.mkdirSync(siteDir, { recursive: true });

  // Save all project files
  let savedFileCount = 0;
  for (const [relativePath, content] of Object.entries(filesMap)) {
    const safeRelativePath = normalizeProjectPath(relativePath);
    if (!safeRelativePath) continue;

    const fullPath = path.resolve(siteDir, safeRelativePath);
    if (!fullPath.startsWith(path.resolve(siteDir) + path.sep) && fullPath !== path.resolve(siteDir)) {
      continue;
    }

    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });

    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(fullPath, content);
    } else {
      fs.writeFileSync(fullPath, content, 'utf8');
    }
    savedFileCount++;
  }

  // Save metadata
  const meta = {
    siteId,
    createdAt: new Date().toISOString(),
    mainFile: metadata.mainFile || 'index.html',
    backendFile: metadata.backendFile || '',
    fileCount: savedFileCount,
    originalUrl: metadata.originalUrl || null,
    originalFilename: metadata.originalFilename || null,
    score: metadata.score || 0,
    improvements: metadata.improvements || [],
    report: metadata.report || '',
    deployMode: metadata.deployMode || 'files',
    mirrorReport: metadata.mirrorReport || null,
  };
  fs.writeFileSync(path.join(siteDir, '__meta__.json'), JSON.stringify(meta, null, 2), 'utf8');

  return siteDir;
}

/**
 * Get a specific file from a site project
 */
export function getSiteFile(siteId, filePath) {
  const siteRoot = resolveSiteDirectory(siteId);
  if (!siteRoot) return null;

  const safeFilePath = normalizeProjectPath(filePath);
  if (!safeFilePath) return null;

  const fullPath = path.resolve(siteRoot, safeFilePath);

  // Prevent path traversal
  if (!fullPath.startsWith(siteRoot + path.sep) && fullPath !== siteRoot) return null;
  if (!fs.existsSync(fullPath)) return null;

  const ext = path.extname(safeFilePath).toLowerCase();
  const textExts = ['.html', '.htm', '.css', '.js', '.json', '.txt', '.md', '.xml', '.svg', '.mjs', '.ts', '.jsx', '.tsx'];
  if (textExts.includes(ext)) {
    return fs.readFileSync(fullPath, 'utf8');
  }
  return fs.readFileSync(fullPath); // Buffer for binary
}

/**
 * List all files in a site project
 */
export function getSiteFileList(siteId) {
  const siteDir = resolveSiteDirectory(siteId);
  if (!siteDir) return [];
  if (!fs.existsSync(siteDir)) return [];
  const files = [];
  walkDir(siteDir, siteDir, files);
  return files.filter((f) => f.path !== '__meta__.json');
}

function walkDir(root, dir, list) {
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (fs.statSync(full).isDirectory()) {
      walkDir(root, full, list);
    } else {
      list.push({ path: rel, size: fs.statSync(full).size });
    }
  }
}

export function getSiteMeta(siteId) {
  const siteDir = resolveSiteDirectory(siteId);
  if (!siteDir) return null;

  const metaPath = path.join(siteDir, '__meta__.json');
  if (!fs.existsSync(metaPath)) return null;
  return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}

export function listSites() {
  if (!fs.existsSync(SITES_DIR)) return [];
  return fs.readdirSync(SITES_DIR)
    .filter((id) => isValidSiteId(id))
    .filter((id) => {
      const p = path.join(SITES_DIR, id);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, '__meta__.json'));
    })
    .map((id) => getSiteMeta(id))
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function deleteSite(siteId) {
  const siteDir = resolveSiteDirectory(siteId);
  if (!siteDir) return false;

  if (fs.existsSync(siteDir)) {
    fs.rmSync(siteDir, { recursive: true, force: true });
    return true;
  }
  return false;
}

export function getSiteDirectory(siteId) {
  const siteDir = resolveSiteDirectory(siteId);
  if (!siteDir) return null;
  if (!fs.existsSync(siteDir)) return null;
  return siteDir;
}
