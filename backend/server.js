import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import unzipper from 'unzipper';
import { createExtractorFromData } from 'node-unrar-js';

import { optimizeSite } from './ai.js';
import { generateSiteId, saveSiteProject, getSiteFile, getSiteMeta, listSites, deleteSite, getSiteFileList, getSiteDirectory, isValidSiteId } from './storage.js';
import { getSitePublicURL, getTunnelInfo, startTunnel, getBasePublicURL } from './tunnel.js';
import { isDockerAvailable, getRuntimeStatus, getRuntimeProxyTarget, startRuntimeForSite, stopRuntimeForSite } from './runtime.js';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const MAX_PROJECT_FILES = Number(process.env.HOSTAI_MAX_PROJECT_FILES || 70000);
const MAX_PROJECT_BYTES = Number(process.env.HOSTAI_MAX_PROJECT_BYTES || (1024 * 1024 * 1024)); // 1GB
const MIRROR_MAX_ASSETS = Number(process.env.HOSTAI_MIRROR_MAX_ASSETS || 500);
const MIRROR_FETCH_TIMEOUT_MS = Number(process.env.HOSTAI_MIRROR_FETCH_TIMEOUT_MS || 10000);
const MIRROR_TOTAL_TIMEOUT_MS = Number(process.env.HOSTAI_MIRROR_TOTAL_TIMEOUT_MS || 90000);
const MIRROR_MAX_ASSET_BYTES = Number(process.env.HOSTAI_MIRROR_MAX_ASSET_BYTES || (20 * 1024 * 1024)); // 20MB
const MIRROR_MAX_TOTAL_BYTES = Number(process.env.HOSTAI_MIRROR_MAX_TOTAL_BYTES || (200 * 1024 * 1024)); // 200MB

// Ensure uploads dir exists
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

// Increase server timeouts for large uploads
app.use((req, res, next) => {
  req.setTimeout(600000);   // 10 min
  res.setTimeout(600000);
  next();
});

// Serve frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Configure multer — accept a single large file (ZIP/RAR) or many files
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,8)}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`),
});
const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024,  // 500MB per file
    files: 70000,                  // 70k files max
    fieldSize: 100 * 1024 * 1024,  // 100MB field size
  },
});

function buildOptimizationPayload(projectFiles, mainFile) {
  const mainDir = path.posix.dirname(mainFile.replace(/\\/g, '/'));
  const toPosix = (value) => value.replace(/\\/g, '/');

  const cssFiles = [];
  const jsFiles = [];

  for (const [filePath, content] of Object.entries(projectFiles)) {
    if (typeof content !== 'string') continue;

    const normalizedPath = toPosix(filePath);
    const extension = path.posix.extname(normalizedPath).toLowerCase();
    const inMainDir = mainDir === '.' ? !normalizedPath.includes('/') : normalizedPath.startsWith(`${mainDir}/`);

    if (!inMainDir) continue;

    if (extension === '.css') cssFiles.push({ path: normalizedPath, content });
    if (extension === '.js' || extension === '.mjs') jsFiles.push({ path: normalizedPath, content });
  }

  return {
    html: typeof projectFiles[mainFile] === 'string' ? projectFiles[mainFile] : '',
    cssFiles,
    jsFiles,
  };
}

function extractAssetReferences(html) {
  if (typeof html !== 'string' || !html.trim()) return [];

  const refs = new Set();
  const attrRegex = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  const srcSetRegex = /srcset\s*=\s*["']([^"']+)["']/gi;
  const styleAttrRegex = /style\s*=\s*["']([^"']+)["']/gi;
  const styleTagRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let match;

  while ((match = attrRegex.exec(html)) !== null) {
    const value = (match[1] || '').trim();
    if (!value) continue;
    if (value.startsWith('data:')) continue;
    if (value.startsWith('javascript:')) continue;
    if (value.startsWith('mailto:')) continue;
    if (value.startsWith('#')) continue;
    refs.add(value);
  }

  while ((match = srcSetRegex.exec(html)) !== null) {
    const srcset = (match[1] || '').trim();
    if (!srcset) continue;
    const candidates = srcset.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
    for (const value of candidates) {
      if (value.startsWith('data:') || value.startsWith('javascript:') || value.startsWith('mailto:') || value.startsWith('#')) continue;
      refs.add(value);
    }
  }

  while ((match = styleAttrRegex.exec(html)) !== null) {
    const styleValue = match[1] || '';
    extractCssAssetReferences(styleValue).forEach((ref) => refs.add(ref));
  }

  while ((match = styleTagRegex.exec(html)) !== null) {
    const css = match[1] || '';
    extractCssAssetReferences(css).forEach((ref) => refs.add(ref));
  }

  return [...refs];
}

function extractCssAssetReferences(cssText) {
  if (typeof cssText !== 'string' || !cssText.trim()) return [];

  const refs = new Set();
  const cssUrlRegex = /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi;
  let match;

  while ((match = cssUrlRegex.exec(cssText)) !== null) {
    const value = (match[2] || '').trim();
    if (!value) continue;
    if (value.startsWith('data:')) continue;
    if (value.startsWith('javascript:')) continue;
    if (value.startsWith('mailto:')) continue;
    if (value.startsWith('#')) continue;
    refs.add(value);
  }

  return [...refs];
}

function toProjectPathFromUrl(urlObj, options = {}) {
  const includeQueryHash = !!options.includeQueryHash;

  let pathname;
  try {
    pathname = decodeURIComponent(urlObj.pathname || '/');
  } catch {
    pathname = urlObj.pathname || '/';
  }
  if (!pathname || pathname === '/') return null;
  if (pathname.endsWith('/')) pathname = `${pathname}index.html`;

  const normalized = pathname.replace(/\\/g, '/').replace(/^\/+/, '');
  let safe = path.posix.normalize(normalized);
  if (!safe || safe === '.' || safe.startsWith('..') || path.posix.isAbsolute(safe)) return null;

  if (includeQueryHash && urlObj.search) {
    const queryHash = crypto.createHash('sha1').update(urlObj.search).digest('hex').slice(0, 8);
    const ext = path.posix.extname(safe);
    const baseName = ext ? safe.slice(0, -ext.length) : safe;
    safe = `${baseName}__q${queryHash}${ext || ''}`;
  }

  return safe;
}

function resolveMirroredAsset(ref, contextUrl, baseOrigin) {
  try {
    const resolved = new URL(ref, contextUrl);
    if (!['http:', 'https:'].includes(resolved.protocol)) return null;
    if (resolved.origin !== baseOrigin) return null;
    return resolved;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'HostAI/2.0 (Site Asset Mirror)' },
      redirect: 'follow',
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function rewriteCssUrls(cssText, contextUrl, mapUrlToProjectPath, currentProjectPath) {
  if (typeof cssText !== 'string' || !cssText.trim()) return cssText;

  const context = String(contextUrl);
  const contextOrigin = new URL(context).origin;

  return cssText.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (full, quote = '', rawValue = '') => {
    const value = String(rawValue || '').trim();
    if (!value || value.startsWith('data:') || value.startsWith('javascript:') || value.startsWith('mailto:') || value.startsWith('#')) {
      return full;
    }

    const resolved = resolveMirroredAsset(value, context, contextOrigin);
    if (!resolved) return full;

    const targetPath = mapUrlToProjectPath.get(resolved.toString());
    if (!targetPath) return full;

    const fromDir = path.posix.dirname(currentProjectPath);
    const rel = path.posix.relative(fromDir, targetPath) || path.posix.basename(targetPath);
    const normalizedRel = rel.startsWith('.') ? rel : `./${rel}`;
    return `url(${quote}${normalizedRel}${quote})`;
  });
}

function rewriteHtmlAssetReferences(html, baseUrl, mapUrlToProjectPath) {
  if (typeof html !== 'string' || !html.trim()) return html;

  const base = new URL(baseUrl);
  const rewriteValue = (rawValue) => {
    const value = String(rawValue || '').trim();
    if (!value || value.startsWith('data:') || value.startsWith('javascript:') || value.startsWith('mailto:') || value.startsWith('#')) {
      return value;
    }
    const resolved = resolveMirroredAsset(value, base, base.origin);
    if (!resolved) return value;
    return mapUrlToProjectPath.get(resolved.toString()) || value;
  };

  let rewritten = html;

  rewritten = rewritten.replace(/(src|href|action|poster)\s*=\s*(["'])([^"']+)\2/gi, (full, attr, quote, value) => {
    const mapped = rewriteValue(value);
    return `${attr}=${quote}${mapped}${quote}`;
  });

  rewritten = rewritten.replace(/srcset\s*=\s*(["'])([^"']+)\1/gi, (full, quote, srcsetValue) => {
    const candidates = String(srcsetValue || '').split(',').map((part) => part.trim()).filter(Boolean);
    const rewrittenCandidates = candidates.map((candidate) => {
      const [urlPart, ...descriptorParts] = candidate.split(/\s+/);
      const mapped = rewriteValue(urlPart);
      return descriptorParts.length ? `${mapped} ${descriptorParts.join(' ')}` : mapped;
    });
    return `srcset=${quote}${rewrittenCandidates.join(', ')}${quote}`;
  });

  rewritten = rewritten.replace(/style\s*=\s*(["'])([\s\S]*?)\1/gi, (full, quote, styleValue) => {
    const css = rewriteCssUrls(styleValue, base, mapUrlToProjectPath, 'index.html');
    return `style=${quote}${css}${quote}`;
  });

  rewritten = rewritten.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (full, attrs, cssText) => {
    const css = rewriteCssUrls(cssText, base, mapUrlToProjectPath, 'index.html');
    return `<style${attrs}>${css}</style>`;
  });

  return rewritten;
}

async function mirrorUrlAssets(baseUrl, html) {
  const base = new URL(baseUrl);
  const refs = extractAssetReferences(html);
  const files = {};
  const visited = new Set();
  const queue = refs.map((ref) => ({ ref, contextUrl: base.toString() }));
  const mapUrlToProjectPath = new Map();
  const mapProjectPathToUrl = new Map();
  const failedAssets = [];
  const warnings = [];
  let mirroredBytes = 0;
  const startedAt = Date.now();

  while (queue.length && visited.size < MIRROR_MAX_ASSETS) {
    if ((Date.now() - startedAt) > MIRROR_TOTAL_TIMEOUT_MS) {
      warnings.push(`Asset mirroring time budget reached (${MIRROR_TOTAL_TIMEOUT_MS}ms).`);
      break;
    }

    const next = queue.shift();
    const assetUrl = resolveMirroredAsset(next.ref, next.contextUrl, base.origin);
    if (!assetUrl) continue;

    const normalizedAssetUrl = assetUrl.toString();
    if (visited.has(normalizedAssetUrl)) continue;
    visited.add(normalizedAssetUrl);

    let projectPath = toProjectPathFromUrl(assetUrl, { includeQueryHash: true });
    if (!projectPath) continue;

    if (files[projectPath]) {
      const ext = path.posix.extname(projectPath);
      const baseName = ext ? projectPath.slice(0, -ext.length) : projectPath;
      projectPath = `${baseName}__dup${visited.size}${ext}`;
      warnings.push(`Path collision detected; renamed mirrored asset: ${projectPath}`);
    }

    try {
      const assetRes = await fetchWithTimeout(assetUrl.toString(), MIRROR_FETCH_TIMEOUT_MS);
      if (!assetRes.ok) {
        failedAssets.push({ url: assetUrl.toString(), status: assetRes.status, reason: assetRes.statusText || 'Fetch failed' });
        continue;
      }

      const declaredLength = Number(assetRes.headers.get('content-length') || 0);
      if (Number.isFinite(declaredLength) && declaredLength > MIRROR_MAX_ASSET_BYTES) {
        failedAssets.push({ url: assetUrl.toString(), status: 413, reason: `Asset exceeds size limit (${formatBytes(MIRROR_MAX_ASSET_BYTES)})` });
        continue;
      }

      const arrayBuf = await assetRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);

      if (buffer.length > MIRROR_MAX_ASSET_BYTES) {
        failedAssets.push({ url: assetUrl.toString(), status: 413, reason: `Asset exceeds size limit (${formatBytes(MIRROR_MAX_ASSET_BYTES)})` });
        continue;
      }

      if ((mirroredBytes + buffer.length) > MIRROR_MAX_TOTAL_BYTES) {
        warnings.push(`Asset mirroring byte budget reached (${formatBytes(MIRROR_MAX_TOTAL_BYTES)}).`);
        break;
      }

      files[projectPath] = buffer;
      mirroredBytes += buffer.length;
      mapUrlToProjectPath.set(assetUrl.toString(), projectPath);
      mapProjectPathToUrl.set(projectPath, assetUrl.toString());

      const contentType = (assetRes.headers.get('content-type') || '').toLowerCase();
      const isCss = contentType.includes('text/css') || projectPath.toLowerCase().endsWith('.css');
      if (isCss) {
        const cssText = buffer.toString('utf8');
        const nestedRefs = extractCssAssetReferences(cssText);
        nestedRefs.forEach((nestedRef) => {
          queue.push({ ref: nestedRef, contextUrl: assetUrl.toString() });
        });
      }
    } catch (err) {
      failedAssets.push({ url: assetUrl.toString(), status: 0, reason: err.message || 'Asset fetch error' });
    }
  }

  for (const [projectPath, buffer] of Object.entries(files)) {
    if (!projectPath.toLowerCase().endsWith('.css')) continue;
    const sourceUrl = mapProjectPathToUrl.get(projectPath);
    if (!sourceUrl) continue;

    const cssText = buffer.toString('utf8');
    const rewrittenCss = rewriteCssUrls(cssText, sourceUrl, mapUrlToProjectPath, projectPath);
    files[projectPath] = Buffer.from(rewrittenCss, 'utf8');
  }

  const rewrittenHtml = rewriteHtmlAssetReferences(html, baseUrl, mapUrlToProjectPath);

  if (visited.size >= MIRROR_MAX_ASSETS && queue.length) {
    warnings.push(`Asset mirroring stopped at max assets (${MIRROR_MAX_ASSETS}).`);
  }

  return {
    files,
    rewrittenHtml,
    report: {
      discoveredAssets: refs.length,
      mirroredAssets: Object.keys(files).length,
      failedAssets,
      warnings,
      mirroredBytes,
    },
  };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.param('siteId', (req, res, next, siteId) => {
  if (!isValidSiteId(siteId)) {
    const wantsJson = req.path.startsWith('/api/');
    if (wantsJson) return res.status(400).json({ error: 'Invalid siteId format' });
    return res.status(400).send('Invalid site id');
  }
  next();
});

/**
 * GET /api/status
 */
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    tunnel: getTunnelInfo(),
    aiConfigured: !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here'),
  });
});

/**
 * GET /api/sites
 */
app.get('/api/sites', (req, res) => {
  try {
    const sites = listSites().map((meta) => ({
      ...meta,
      publicUrl: getSitePublicURL(meta.siteId),
    }));
    res.json({ sites });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/deploy/url
 */
app.post('/api/deploy/url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs are supported' });
    }

    console.log(`[DEPLOY-URL] Fetching: ${url}`);
    const fetchRes = await fetch(url, {
      headers: { 'User-Agent': 'HostAI/2.0 (Site Optimizer)' },
      redirect: 'follow',
    });

    if (!fetchRes.ok) {
      return res.status(400).json({ error: `Failed to fetch: ${fetchRes.status} ${fetchRes.statusText}` });
    }

    const rawHTML = await fetchRes.text();
    console.log(`[AI] Optimizing site from URL...`);
    const aiResult = await optimizeSite(rawHTML);

    const siteId = generateSiteId();
    const optimizedHtml = aiResult.optimizedHTML || rawHTML;
    const files = {};

    const mirrored = await mirrorUrlAssets(url, optimizedHtml);
    files['index.html'] = mirrored.rewrittenHtml || optimizedHtml;
    Object.assign(files, mirrored.files);

    if (mirrored.report.failedAssets.length) {
      console.warn(`[DEPLOY-URL] Mirroring had ${mirrored.report.failedAssets.length} failed assets`);
    }
    mirrored.report.warnings.forEach((warning) => {
      console.warn(`[DEPLOY-URL] Warning: ${warning}`);
    });

    await saveSiteProject(siteId, files, {
      originalUrl: url,
      mainFile: 'index.html',
      fileCount: Object.keys(files).length,
      score: aiResult.score,
      improvements: aiResult.improvements,
      report: aiResult.report,
      deployMode: 'url',
      mirrorReport: mirrored.report,
    });

    const publicUrl = getSitePublicURL(siteId);
    console.log(`[DEPLOY-URL] Done → ${publicUrl}`);

    res.json({
      success: true,
      siteId,
      publicUrl,
      fileCount: Object.keys(files).length,
      score: aiResult.score,
      improvements: aiResult.improvements,
      report: aiResult.report,
      mirrorReport: mirrored.report,
    });
  } catch (err) {
    console.error('[DEPLOY-URL] Error:', err.message);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'URL deploy timed out while fetching assets' });
    }
    res.status(500).json({ error: err.message || 'URL deploy failed' });
  }
});

/**
 * POST /api/deploy/archive — Deploy from a single ZIP or RAR file
 * This is the primary route for large projects (60k+ files).
 * The frontend ZIPs the folder client-side, or user uploads a ZIP/RAR directly.
 */
app.post('/api/deploy/archive', upload.single('archive'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No archive file uploaded' });
  }

  const archivePath = req.file.path;
  const originalName = req.file.originalname.toLowerCase();
  const mainFile = req.body.mainFile || 'index.html';
  const backendFile = req.body.backendFile || '';
  let extractDir = null;

  try {
    console.log(`[DEPLOY-ARCHIVE] Processing: ${req.file.originalname} (${formatBytes(req.file.size)})`);
    extractDir = path.join(UPLOADS_DIR, `extract-${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });

    // Extract based on file type
    if (originalName.endsWith('.zip')) {
      console.log('[EXTRACT] Extracting ZIP...');
      await extractZip(archivePath, extractDir);
    } else if (originalName.endsWith('.rar')) {
      console.log('[EXTRACT] Extracting RAR...');
      await extractRar(archivePath, extractDir);
    } else {
      throw new Error('Unsupported archive type. Use .zip or .rar');
    }

    // Collect all files from extracted directory
    console.log('[EXTRACT] Collecting files...');
    const projectFiles = {};
    const collectionStats = { files: 0, bytes: 0 };
    collectFiles(extractDir, extractDir, projectFiles, collectionStats);
    const fileCount = Object.keys(projectFiles).length;
    console.log(`[EXTRACT] Found ${fileCount} files`);

    // Cleanup
    fs.unlinkSync(archivePath);
    fs.rmSync(extractDir, { recursive: true, force: true });

    if (fileCount === 0) {
      return res.status(400).json({ error: 'Archive contained no files.' });
    }

    // AI optimize main HTML file only (skip for huge projects to save time)
    let aiResult = { score: 0, improvements: [], report: 'Skipped — large project.' };
    const mainContent = projectFiles[mainFile];

    if (mainContent && typeof mainContent === 'string' && mainFile.match(/\.html?$/i)) {
      if (fileCount <= 5000) {
        console.log(`[AI] Optimizing main file: ${mainFile}`);
        aiResult = await optimizeSite(buildOptimizationPayload(projectFiles, mainFile));
        if (aiResult.optimizedHTML) projectFiles[mainFile] = aiResult.optimizedHTML;
      } else {
        aiResult.report = `Large project (${fileCount} files) — AI optimization skipped for speed. Site deployed as-is.`;
        aiResult.score = 70;
        aiResult.improvements = ['Direct deployment — no changes made'];
      }
    }

    // Store
    const siteId = generateSiteId();
    await saveSiteProject(siteId, projectFiles, {
      mainFile,
      backendFile,
      fileCount,
      score: aiResult.score,
      improvements: aiResult.improvements,
      report: aiResult.report,
      deployMode: 'archive',
    });

    const publicUrl = getSitePublicURL(siteId);
    console.log(`[DEPLOY-ARCHIVE] Done → ${publicUrl} (${fileCount} files)`);

    res.json({
      success: true,
      siteId,
      publicUrl,
      fileCount,
      mainFile,
      score: aiResult.score,
      improvements: aiResult.improvements,
      report: aiResult.report,
    });
  } catch (err) {
    console.error('[DEPLOY-ARCHIVE] Error:', err.message);
    // Cleanup on error
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    if (extractDir && fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });

    const message = err.message || 'Archive deploy failed';
    if (message.includes('Unsafe archive entry path')) {
      return res.status(400).json({ error: 'Archive contains unsafe paths and was rejected' });
    }
    if (message.includes('Unsupported archive type')) {
      return res.status(400).json({ error: message });
    }
    if (message.includes('File limit exceeded') || message.includes('Project size limit exceeded')) {
      return res.status(413).json({ error: message });
    }
    if (message.includes('invalid') || message.includes('corrupt') || message.includes('CRC')) {
      return res.status(400).json({ error: 'Archive is invalid or corrupted' });
    }

    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/deploy/files — Deploy individual files (small projects only)
 */
app.post('/api/deploy/files', upload.array('files', 500), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  try {
    const mainFile = req.body.mainFile || 'index.html';
    const backendFile = req.body.backendFile || '';
    const projectFiles = {};
    const duplicatePaths = [];

    // relativePaths[] is an optional parallel array sent by the frontend
    // containing the full relative path (including subfolders) for each file.
    // Multer strips directory separators from originalname for security,
    // so without this, files in subfolders (e.g. assets/) end up stored flat.
    const relativePaths = Array.isArray(req.body.relativePaths)
      ? req.body.relativePaths
      : (req.body.relativePaths ? [req.body.relativePaths] : []);

    for (let i = 0; i < req.files.length; i++) {
      const f = req.files[i];
      // Prefer the explicit relativePath sent by frontend; fall back to originalname
      const rawRelPath = relativePaths[i] || f.originalname;

      // Sanitize: allow forward slashes (subfolders) but block traversal
      const safePath = rawRelPath
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\.\.\//g, '')
        .replace(/^\.\.\//, '');
      const relativePath = safePath || f.originalname;

      if (Object.prototype.hasOwnProperty.call(projectFiles, relativePath)) {
        duplicatePaths.push(relativePath);
        continue;
      }

      const content = fs.readFileSync(f.path);
      const ext = path.extname(relativePath).toLowerCase();
      if (TEXT_EXTS.includes(ext)) {
        projectFiles[relativePath] = content.toString('utf8');
      } else {
        projectFiles[relativePath] = content;
      }
    }

    // Cleanup
    req.files.forEach((f) => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });

    if (duplicatePaths.length) {
      return res.status(400).json({
        error: `Duplicate file paths detected (${duplicatePaths.length}). Re-upload with unique folder roots or as ZIP.`,
      });
    }

    // AI optimize
    let aiResult = { score: 0, improvements: [], report: 'No optimization.' };
    const mainContent = projectFiles[mainFile];
    if (mainContent && typeof mainContent === 'string' && mainFile.match(/\.html?$/i)) {
      console.log(`[AI] Optimizing: ${mainFile}`);
      aiResult = await optimizeSite(buildOptimizationPayload(projectFiles, mainFile));
      if (aiResult.optimizedHTML) projectFiles[mainFile] = aiResult.optimizedHTML;
    }

    const siteId = generateSiteId();
    await saveSiteProject(siteId, projectFiles, {
      mainFile,
      backendFile,
      fileCount: Object.keys(projectFiles).length,
      score: aiResult.score,
      improvements: aiResult.improvements,
      report: aiResult.report,
      deployMode: 'files',
    });

    const publicUrl = getSitePublicURL(siteId);
    console.log(`[DEPLOY-FILES] Done → ${publicUrl}`);

    res.json({
      success: true,
      siteId,
      publicUrl,
      fileCount: Object.keys(projectFiles).length,
      mainFile,
      score: aiResult.score,
      improvements: aiResult.improvements,
      report: aiResult.report,
    });
  } catch (err) {
    console.error('[DEPLOY-FILES] Error:', err.message);
    if ((err.message || '').includes('Invalid siteId')) {
      return res.status(400).json({ error: 'Invalid site identifier' });
    }
    res.status(500).json({ error: err.message || 'File deploy failed' });
  }
});

/**
 * POST /api/archive/preview — Upload archive and return file list for picking main file
 */
app.post('/api/archive/preview', upload.single('archive'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No archive uploaded' });

  const archivePath = req.file.path;
  const originalName = req.file.originalname.toLowerCase();
  let extractDir = null;

  try {
    extractDir = path.join(UPLOADS_DIR, `preview-${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });

    if (originalName.endsWith('.zip')) {
      await extractZip(archivePath, extractDir);
    } else if (originalName.endsWith('.rar')) {
      await extractRar(archivePath, extractDir);
    } else {
      throw new Error('Unsupported format. Use .zip or .rar');
    }

    const files = [];
    const previewStats = { files: 0 };
    collectFilePaths(extractDir, extractDir, files, previewStats);

    // Limit to first 200 for display
    const displayFiles = files.slice(0, 200);

    // Cleanup
    fs.unlinkSync(archivePath);
    fs.rmSync(extractDir, { recursive: true, force: true });

    // Auto-detect
    const htmlFiles = files.filter((f) => f.type === '.html' || f.type === '.htm');
    const jsFiles = files.filter((f) => f.type === '.js');

    const suggestedMain = htmlFiles.find((f) => f.path.endsWith('index.html'))?.path
      || htmlFiles[0]?.path || '';
    const suggestedBackend = jsFiles.find((f) =>
      f.path.includes('server.') || f.path.includes('app.')
    )?.path || '';

    res.json({
      files: displayFiles,
      totalFiles: files.length,
      suggestedMain,
      suggestedBackend,
    });
  } catch (err) {
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    if (extractDir && fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });

    const message = err.message || 'Archive preview failed';
    if (message.includes('Unsafe archive entry path')) {
      return res.status(400).json({ error: 'Archive contains unsafe paths and was rejected' });
    }
    if (message.includes('File limit exceeded')) {
      return res.status(413).json({ error: message });
    }
    if (message.includes('invalid') || message.includes('corrupt') || message.includes('CRC')) {
      return res.status(400).json({ error: 'Archive is invalid or corrupted' });
    }

    res.status(500).json({ error: message });
  }
});

// ─── SITE SERVING ─────────────────────────────────────────────────────────────


// CDN SDK scripts that MUST be synchronous - inline scripts call their APIs immediately.
// Adding defer causes 'firebase is not defined' / 'Razorpay is not defined' errors.
const SYNC_SDK_DOMAINS = [
  'checkout.razorpay.com',
  'gstatic.com/firebasejs',
  'cdn.jsdelivr.net/npm/@emailjs',
  'cdnjs.cloudflare.com/ajax/libs/qrcodejs',
];

function rewriteHostedHtml(siteId, html) {
  if (typeof html !== 'string') return html;

  const basePath = `/site/${siteId}/`;
  let rewritten = html;

  if (/<base\s+href=/i.test(rewritten)) {
    rewritten = rewritten.replace(/<base\s+href\s*=\s*(["'])([^"']*)\1[^>]*>/i, `<base href="${basePath}">`);
  } else if (/<head[^>]*>/i.test(rewritten)) {
    rewritten = rewritten.replace(/<head([^>]*)>/i, `<head$1>\n  <base href="${basePath}">`);
  }

  rewritten = rewritten.replace(
    /(src|href|action|poster)=(["'])\/(?!\/|site\/|api\/)/gi,
    `$1=$2${basePath}`
  );

  rewritten = rewritten.replace(/srcset\s*=\s*(["'])([^"']+)\1/gi, (full, quote, srcsetValue) => {
    const candidates = String(srcsetValue || '').split(',').map((part) => part.trim()).filter(Boolean);
    const rewrittenCandidates = candidates.map((candidate) => {
      const [urlPart, ...descriptorParts] = candidate.split(/\s+/);
      const normalizedUrl = urlPart.startsWith('/') && !urlPart.startsWith('//') && !urlPart.startsWith('/site/') && !urlPart.startsWith('/api/')
        ? `${basePath}${urlPart.replace(/^\/+/, '')}`
        : urlPart;
      return descriptorParts.length ? `${normalizedUrl} ${descriptorParts.join(' ')}` : normalizedUrl;
    });

    return `srcset=${quote}${rewrittenCandidates.join(', ')}${quote}`;
  });

  // Strip incorrectly-added defer from CDN SDK scripts that must load synchronously.
  rewritten = rewritten.replace(/<script\b([^>]*)>/gi, (fullTag, attrs) => {
    const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (!srcMatch) return fullTag;
    const scriptUrl = srcMatch[1];
    const isSync = SYNC_SDK_DOMAINS.some((domain) => scriptUrl.includes(domain));
    if (isSync && /\bdefer\b/i.test(attrs)) {
      return '<script' + attrs.replace(/\s*\bdefer\b/gi, '') + '>';
    }
    return fullTag;
  });

  return rewritten;
}

// ── Python/Node Backend API Proxy ───────────────────────────────────────────
// Forward /site/:siteId/api/* and /site/:siteId/health to the running backend
app.all('/site/:siteId/api/{*apiPath}', (req, res) => {
  const target = getRuntimeProxyTarget(req.params.siteId);
  if (!target) {
    return res.status(503).json({ error: 'Backend not running. Start the runtime first.' });
  }

  const targetUrl = new URL(target);
  // Strip /site/:siteId prefix — keep /api/...
  const apiPath = req.originalUrl.replace(`/site/${req.params.siteId}`, '');

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    path: apiPath,
    method: req.method,
    headers: { ...req.headers, host: `${targetUrl.hostname}:${targetUrl.port}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error(`[PROXY] Error forwarding to backend:`, err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Backend proxy error', detail: err.message });
  });

  if (req.body && Object.keys(req.body).length > 0) {
    const bodyStr = JSON.stringify(req.body);
    proxyReq.setHeader('Content-Type', 'application/json');
    proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyStr));
    proxyReq.write(bodyStr);
  }

  proxyReq.end();
});

app.all('/site/:siteId/health', (req, res) => {
  const target = getRuntimeProxyTarget(req.params.siteId);
  if (!target) return res.status(503).json({ running: false });
  const targetUrl = new URL(target);
  const options = { hostname: targetUrl.hostname, port: targetUrl.port, path: '/health', method: 'GET' };
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxyReq.on('error', () => res.status(502).json({ running: false }));
  proxyReq.end();
});

app.get('/site/:siteId', (req, res) => {
  const originalPath = (req.originalUrl || '').split('?')[0];
  if (!originalPath.endsWith('/')) {
    return res.redirect(302, `/site/${req.params.siteId}/`);
  }

  const meta = getSiteMeta(req.params.siteId);
  if (!meta) return res.status(404).send('<h1>Site not found</h1>');

  const mainFile = meta.mainFile || 'index.html';
  let content = getSiteFile(req.params.siteId, mainFile);
  if (!content) return res.status(404).send('<h1>Main file not found</h1>');

  if (/\.html?$/i.test(mainFile) && typeof content === 'string') {
    content = rewriteHostedHtml(req.params.siteId, content);
  }

  res.setHeader('Content-Type', getContentType(mainFile));
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(content);
});

app.get('/site/:siteId/{*filePath}', (req, res) => {
  const { siteId, filePath } = req.params;
  let resolvedPath = Array.isArray(filePath) ? filePath.join('/') : String(filePath || '');
  const requestPath = (req.originalUrl || '').split('?')[0];

  if (requestPath.endsWith('/')) {
    resolvedPath = `${resolvedPath.replace(/\/+$/, '')}/index.html`;
  }

  let content = getSiteFile(siteId, resolvedPath);
  if (!content) {
    const normalized = String(resolvedPath || '').replace(/\\/g, '/');
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(normalized);
    if (!hasExtension && !requestPath.endsWith('/')) {
      const indexCandidate = `${normalized.replace(/\/+$/, '')}/index.html`;
      if (getSiteFile(siteId, indexCandidate)) {
        return res.redirect(302, `${requestPath}/`);
      }
    }
    return res.status(404).send('File not found');
  }

  if (/\.html?$/i.test(resolvedPath) && typeof content === 'string') {
    content = rewriteHostedHtml(siteId, content);
  }

  res.setHeader('Content-Type', getContentType(resolvedPath));
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(content);
});

app.get('/api/sites/:siteId', (req, res) => {
  const meta = getSiteMeta(req.params.siteId);
  if (!meta) return res.status(404).json({ error: 'Site not found' });
  res.json({
    ...meta,
    publicUrl: getSitePublicURL(meta.siteId),
    files: getSiteFileList(meta.siteId),
  });
});

app.delete('/api/sites/:siteId', (req, res) => {
  const deleted = deleteSite(req.params.siteId);
  if (!deleted) return res.status(404).json({ error: 'Site not found' });
  res.json({ success: true });
});

app.get('/api/sites/:siteId/runtime', async (req, res) => {
  const siteId = req.params.siteId;
  const meta = getSiteMeta(siteId);
  if (!meta) return res.status(404).json({ error: 'Site not found' });

  try {
    const dockerAvailable = await isDockerAvailable();
    const status = await getRuntimeStatus(siteId);
    res.json({
      dockerAvailable,
      ...status,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sites/:siteId/runtime/start', async (req, res) => {
  const siteId = req.params.siteId;
  const meta = getSiteMeta(siteId);
  if (!meta) return res.status(404).json({ error: 'Site not found' });

  const siteDir = getSiteDirectory(siteId);
  if (!siteDir) return res.status(404).json({ error: 'Site files not found' });

  const backendFile = req.body?.backendFile || meta.backendFile;
  if (!backendFile) {
    return res.status(400).json({ error: 'No backend file specified for runtime start' });
  }

  try {
    const runtime = await startRuntimeForSite({ siteId, siteDir, backendFile });
    res.json({ success: true, runtime });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sites/:siteId/runtime/stop', async (req, res) => {
  const siteId = req.params.siteId;
  const meta = getSiteMeta(siteId);
  if (!meta) return res.status(404).json({ error: 'Site not found' });

  try {
    const result = await stopRuntimeForSite(siteId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback → frontend
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// Global error handler — prevent HTML error pages
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err.message);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── ARCHIVE EXTRACTION ──────────────────────────────────────────────────────

async function extractZip(zipPath, outputDir) {
  const outputRoot = path.resolve(outputDir);
  const parser = fs.createReadStream(zipPath).pipe(unzipper.Parse({ forceStream: true }));

  for await (const entry of parser) {
    const rawPath = entry.path || entry.vars?.path || '';
    const safeEntryPath = sanitizeArchiveEntryPath(rawPath);
    if (!safeEntryPath) {
      entry.autodrain();
      throw new Error(`Unsafe archive entry path: ${rawPath}`);
    }

    const destination = path.resolve(outputRoot, safeEntryPath);
    if (!destination.startsWith(outputRoot + path.sep)) {
      entry.autodrain();
      throw new Error(`Unsafe archive entry path: ${rawPath}`);
    }

    if (entry.type === 'Directory') {
      fs.mkdirSync(destination, { recursive: true });
      entry.autodrain();
      continue;
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(destination);
      out.on('finish', resolve);
      out.on('error', reject);
      entry.on('error', reject);
      entry.pipe(out);
    });
  }
}

async function extractRar(rarPath, outputDir) {
  const rarData = fs.readFileSync(rarPath);
  const buf = Uint8Array.from(rarData).buffer;
  const extractor = await createExtractorFromData({ data: buf });
  const list = extractor.extract();
  const files = [...list.files];

  for (const file of files) {
    if (file.fileHeader.flags.directory) continue;
    const rawName = file.fileHeader.name || '';
    const safeEntryPath = sanitizeArchiveEntryPath(rawName);
    if (!safeEntryPath) {
      throw new Error(`Unsafe archive entry path: ${rawName}`);
    }

    const filePath = path.resolve(outputDir, safeEntryPath);
    const outputRoot = path.resolve(outputDir);
    if (!filePath.startsWith(outputRoot + path.sep)) {
      throw new Error(`Unsafe archive entry path: ${rawName}`);
    }

    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    if (file.extraction) {
      fs.writeFileSync(filePath, Buffer.from(file.extraction));
    }
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const TEXT_EXTS = ['.html', '.htm', '.css', '.js', '.json', '.txt', '.md', '.xml', '.svg', '.env', '.yml', '.yaml', '.ts', '.jsx', '.tsx', '.mjs', '.vue', '.php', '.py', '.rb', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.toml', '.cfg', '.ini', '.sh', '.bat', '.ps1', '.gitignore', '.editorconfig'];

function sanitizeArchiveEntryPath(entryPath) {
  if (typeof entryPath !== 'string' || !entryPath.trim()) return null;
  const cleaned = entryPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^[a-zA-Z]:\//, '');
  const normalized = path.posix.normalize(cleaned);
  if (!normalized || normalized === '.' || normalized.startsWith('..') || path.posix.isAbsolute(normalized) || normalized.includes('\0')) {
    return null;
  }
  return normalized;
}

function collectFiles(rootDir, currentDir, map, stats = { files: 0, bytes: 0 }) {
  let items;
  try { items = fs.readdirSync(currentDir); } catch { return; }
  for (const item of items) {
    if (item === '__MACOSX' || item === '.DS_Store' || item === 'node_modules' || item === '.git') continue;
    const fullPath = path.join(currentDir, item);
    let stat;
    try { stat = fs.statSync(fullPath); } catch { continue; }
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
    if (stat.isDirectory()) {
      collectFiles(rootDir, fullPath, map, stats);
    } else {
      stats.files++;
      stats.bytes += stat.size;

      if (stats.files > MAX_PROJECT_FILES) {
        throw new Error(`File limit exceeded (${MAX_PROJECT_FILES.toLocaleString()} max)`);
      }
      if (stats.bytes > MAX_PROJECT_BYTES) {
        throw new Error(`Project size limit exceeded (${formatBytes(MAX_PROJECT_BYTES)} max)`);
      }

      const ext = path.extname(item).toLowerCase();
      try {
        if (TEXT_EXTS.includes(ext)) {
          map[relativePath] = fs.readFileSync(fullPath, 'utf8');
        } else {
          map[relativePath] = fs.readFileSync(fullPath);
        }
      } catch { /* skip unreadable files */ }
    }
  }
}

function collectFilePaths(rootDir, currentDir, list, stats = { files: 0 }) {
  let items;
  try { items = fs.readdirSync(currentDir); } catch { return; }
  for (const item of items) {
    if (item === '__MACOSX' || item === '.DS_Store' || item === 'node_modules' || item === '.git') continue;
    const fullPath = path.join(currentDir, item);
    let stat;
    try { stat = fs.statSync(fullPath); } catch { continue; }
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
    if (stat.isDirectory()) {
      collectFilePaths(rootDir, fullPath, list, stats);
    } else {
      stats.files++;
      if (stats.files > MAX_PROJECT_FILES) {
        throw new Error(`File limit exceeded (${MAX_PROJECT_FILES.toLocaleString()} max)`);
      }
      list.push({ path: relativePath, size: stat.size, type: path.extname(item).toLowerCase() });
    }
  }
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
    '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  };
  return types[ext] || 'application/octet-stream';
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

// ─── START ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
  console.log(`\n🚀 HostAI Server v2.0`);
  console.log(`   Local:     http://localhost:${PORT}`);
  console.log(`   AI Status: ${process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here' ? '✅ Configured' : '⚠️  Set ANTHROPIC_API_KEY in .env'}`);
  console.log(`   Limits:    500MB archive, 60k+ files, ZIP + RAR`);

  const publicUrl = await startTunnel(PORT);
  if (publicUrl) {
    console.log(`   Public:    ${publicUrl}\n`);
  } else {
    console.log(`   Public:    Not available (local only)\n`);
  }
});

server.timeout = 600000;       // 10 min
server.keepAliveTimeout = 120000;
server.headersTimeout = 620000;
