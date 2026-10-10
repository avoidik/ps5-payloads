#!/usr/bin/env node
// Generate a PS5 Payload Manager (pldmgr) source file from catalog.yaml.
//
// Usage: node generate.mjs [catalog.yaml] [--out payloads.json] [--dry-run]
//
// pldmgr does not use a real JSON parser: it scans each '{' to the next '}'
// and looks up keys with strstr. The output is therefore shaped to survive
// that scanner (see README.md), and every value is checked against its limits.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { load as loadYaml } from 'js-yaml';

// Field buffer sizes in pldmgr's RepoPayload struct, minus the NUL terminator.
const LIMITS = { name: 127, filename: 255, url: 1023, description: 1023, version: 63, category: 127 };
const SOURCE_NAME_LIMIT = 255;
const PAYLOAD_KEYS = ['name', 'filename', 'url', 'description', 'version', 'category', 'checksum', 'requires', 'homepage', 'release_type', 'released', 'catalog', 'catalog_url'];
// Fields taken from external catalogs; anything else they carry is dropped
const PLDMGR_FIELDS = ['name', 'filename', 'url', 'description', 'version', 'category', 'checksum'];
const RELEASES_PER_PAGE = 100; // GitHub's maximum
// pldmgr only launches these (is_supported_extension in payload_mgr.c)
const SUPPORTED_EXTENSIONS = ['.elf', '.bin'];
// The scanner ends an object at the first '}', ignores escapes and stops at '"'.
// eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
const UNSAFE_CHARS = /[{}"\\\u0000-\u001f\u007f]/;

class CatalogError extends Error {}

function fail(msg) {
  throw new CatalogError(msg);
}

function parseArgs(argv) {
  const opts = { catalog: 'catalog.yaml', out: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--out') {
      if (!argv[i + 1]) fail('--out requires a path');
      opts.out = argv[++i];
    } else if (a === '-h' || a === '--help') {
      console.log('Usage: node generate.mjs [catalog.yaml] [--out payloads.json] [--dry-run]');
      process.exit(0);
    } else if (a.startsWith('-')) fail(`unknown option: ${a}`);
    else opts.catalog = a;
  }
  return opts;
}

// ── Catalog loading and validation ──────────────────────────

function loadCatalog(file) {
  let doc;
  try {
    doc = loadYaml(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`cannot read ${file}: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object') fail(`${file}: expected a mapping at top level`);
  if (typeof doc.name !== 'string' || !doc.name.trim()) fail(`${file}: top-level "name" is required`);
  if (!Array.isArray(doc.payloads) || doc.payloads.length === 0) fail(`${file}: "payloads" must be a non-empty list`);

  doc.external ??= [];
  if (!Array.isArray(doc.external)) fail(`${file}: "external" must be a list`);
  doc.external.forEach((c, i) => {
    if (!c || typeof c.url !== 'string' || !/^https?:\/\//.test(c.url)) fail(`external[${i}]: "url" must be an http(s) URL`);
    if (typeof c.name !== 'string' || !c.name.trim() || UNSAFE_CHARS.test(c.name)) {
      fail(`external[${i}]: "name" is required, without { } " \\ or control characters`);
    }
    if (c.homepage !== undefined && (typeof c.homepage !== 'string' || !/^https?:\/\//.test(c.homepage))) {
      fail(`external[${i}]: "homepage" must be an http(s) URL`);
    }
  });


  const ids = new Set();
  doc.payloads.forEach((p, i) => {
    const where = `payloads[${i}]${p?.id ? ` (${p.id})` : ''}`;
    if (!p || typeof p !== 'object') fail(`${where}: expected a mapping`);
    for (const key of ['id', 'name']) {
      if (typeof p[key] !== 'string' || !p[key].trim()) fail(`${where}: "${key}" is required`);
    }
    if (ids.has(p.id)) fail(`${where}: duplicate id "${p.id}"`);
    if (!SUPPORTED_EXTENSIONS.includes(p.extension)) {
      fail(`${where}: "extension" must be one of ${SUPPORTED_EXTENSIONS.join(', ')}`);
    }
    ids.add(p.id);

    if (p.requires !== undefined && !(Array.isArray(p.requires) && p.requires.every((r) => typeof r === 'string'))) {
      fail(`${where}: "requires" must be a list of ids`);
    }
    for (const key of ['description', 'category', 'filename', 'version']) {
      if (p[key] !== undefined && typeof p[key] !== 'string') fail(`${where}: "${key}" must be a string`);
    }

    const src = p.source;
    if (!src || typeof src !== 'object') fail(`${where}: "source" is required`);
    if (src.type === 'github') {
      if (typeof src.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(src.repo)) fail(`${where}: source.repo must be "owner/name"`);
      if (typeof src.asset !== 'string') fail(`${where}: source.asset (regex) is required`);
      try {
        src.assetRe = new RegExp(src.asset);
      } catch (e) {
        fail(`${where}: invalid source.asset regex: ${e.message}`);
      }
      if (src.tag !== undefined) src.tag = String(src.tag);
      if (src.prerelease !== undefined && typeof src.prerelease !== 'boolean') fail(`${where}: source.prerelease must be true or false`);
    } else if (src.type === 'url') {
      if (typeof src.url !== 'string' || !/^https?:\/\//.test(src.url)) fail(`${where}: source.url must be an http(s) URL`);
      if (src.version !== undefined) src.version = String(src.version);
      if (src.homepage !== undefined && (typeof src.homepage !== 'string' || !/^https?:\/\//.test(src.homepage))) {
        fail(`${where}: source.homepage must be an http(s) URL`);
      }
    } else {
      fail(`${where}: source.type must be "github" or "url"`);
    }
  });

  for (const p of doc.payloads) {
    for (const r of p.requires ?? []) {
      if (!ids.has(r)) fail(`${p.id}: requires unknown id "${r}"`);
      if (r === p.id) fail(`${p.id}: requires itself`);
    }
  }
  return doc;
}

// Dependencies first; otherwise keep catalog order. Rejects cycles.
function orderByDependencies(payloads) {
  const byId = new Map(payloads.map((p) => [p.id, p]));
  const state = new Map(); // id -> 'visiting' | 'done'
  const ordered = [];
  const visit = (p, trail) => {
    const s = state.get(p.id);
    if (s === 'done') return;
    if (s === 'visiting') fail(`dependency cycle: ${[...trail, p.id].join(' -> ')}`);
    state.set(p.id, 'visiting');
    for (const r of p.requires ?? []) visit(byId.get(r), [...trail, p.id]);
    state.set(p.id, 'done');
    ordered.push(p);
  };
  for (const p of payloads) visit(p, []);
  return ordered;
}

// ── Upstream resolution ─────────────────────────────────────

function githubHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'ps5-payloads-generator' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function githubGet(url) {
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 429 ? ' (rate limited? set GITHUB_TOKEN)' : '';
    fail(`GitHub API ${res.status} for ${url}${hint}`);
  }
  return res.json();
}

async function resolveGithub(p) {
  const { repo, tag, assetRe, prerelease = false } = p.source;
  const releases = tag
    ? [await githubGet(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)]
    : (await githubGet(`https://api.github.com/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}`))
        .filter((rel) => !rel.draft && (prerelease || !rel.prerelease))
        // The API orders releases by creation date, which can differ from when they were published
        .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));

  for (const rel of releases) {
    const matches = rel.assets.filter((a) => assetRe.test(a.name));
    if (matches.length > 1) fail(`${p.id}: regex matches several assets in ${repo}@${rel.tag_name}: ${matches.map((a) => a.name).join(', ')}`);
    if (matches.length === 1) {
      const a = matches[0];
      return {
        url: a.browser_download_url,
        filename: a.name,
        version: rel.tag_name,
        homepage: `https://github.com/${repo}`,
        releaseType: rel.prerelease ? 'pre-release' : 'stable',
        released: rel.published_at,
        size: a.size,
        digest: a.digest?.startsWith('sha256:') ? a.digest.slice(7).toLowerCase() : null,
      };
    }
  }
  const kinds = prerelease ? 'releases and pre-releases' : 'releases';
  const scope = tag ? `release ${tag}` : `the last ${RELEASES_PER_PAGE} ${kinds}`;
  throw new CatalogError(`${p.id}: no asset matching /${p.source.asset}/ in ${scope} of ${repo}`);
}

function resolveUrl(p) {
  const { url, version, homepage } = p.source;
  const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  return { url, filename, version: version ?? '', homepage, size: null, digest: null };
}

async function sha256OfUrl(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'ps5-payloads-generator' } });
  if (!res.ok || !res.body) fail(`download failed (HTTP ${res.status}): ${url}`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of Readable.fromWeb(res.body)) {
    hash.update(chunk);
    size += chunk.length;
  }
  // Release date fallback for files that don't come from a GitHub release lookup
  const lastModified = Date.parse(res.headers.get('last-modified') ?? '');
  const modified = Number.isNaN(lastModified) ? null : new Date(lastModified).toISOString().replace('.000Z', 'Z');
  return { checksum: hash.digest('hex'), size, modified };
}

// Date and type of the GitHub release a download URL points at, if it points at one
async function githubReleaseOf(url) {
  const m = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/(?:download\/([^/]+)|latest\/download)\//);
  if (!m) return null;
  const [, repo, tag] = m;
  const api = `https://api.github.com/repos/${repo}/releases/${tag ? `tags/${tag}` : 'latest'}`;
  try {
    const rel = await githubGet(api);
    return { released: rel.published_at, releaseType: rel.prerelease ? 'pre-release' : 'stable' };
  } catch (e) {
    if (!(e instanceof CatalogError)) throw e;
    warn(`no release info for ${url}: ${e.message}`);
    return null;
  }
}

async function resolvePayload(p) {
  const up = p.source.type === 'github' ? await resolveGithub(p) : resolveUrl(p);
  const { checksum, size, modified } = await sha256OfUrl(up.url);
  if (size === 0) fail(`${p.id}: downloaded file is empty: ${up.url}`);
  if (up.size != null && size !== up.size) fail(`${p.id}: size mismatch for ${up.url} (expected ${up.size}, got ${size})`);
  if (up.digest && up.digest !== checksum) fail(`${p.id}: checksum mismatch for ${up.url} (GitHub ${up.digest}, computed ${checksum})`);
  // Direct URLs: use the GitHub release they point at, else the server's Last-Modified
  const rel = up.released ? null : await githubReleaseOf(up.url);
  return { ...up, ...rel, checksum, size, released: up.released ?? rel?.released ?? modified };
}

// ── External catalogs ───────────────────────────────────────

function warn(msg) {
  // Shown as an annotation in GitHub Actions
  console.error(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : `warning: ${msg}`);
}

// Project page for a file hosted on GitHub in any form (release asset, raw, blob, ...)
function githubRepoPage(url) {
  const { hostname, pathname } = new URL(url);
  if (hostname !== 'github.com' && hostname !== 'raw.githubusercontent.com') return null;
  const [owner, repo] = pathname.split('/').filter(Boolean);
  return owner && repo ? `https://github.com/${owner}/${repo}` : null;
}

async function loadExternal(ext) {
  const res = await fetch(ext.url, { headers: { 'User-Agent': 'ps5-payloads-generator' } });
  if (!res.ok) fail(`external catalog ${ext.url}: HTTP ${res.status}`);
  let doc;
  try {
    doc = await res.json();
  } catch (e) {
    fail(`external catalog ${ext.url}: invalid JSON (${e.message})`);
  }
  const items = Array.isArray(doc) ? doc : doc?.payloads;
  if (!Array.isArray(items)) fail(`external catalog ${ext.url}: no "payloads" list`);
  return { name: ext.name.trim(), url: ext.url, homepage: ext.homepage, items };
}

// Takes an entry as published, but still downloads and hashes the file. Entries we
// can't serve safely are skipped, so one bad third-party entry doesn't block the build.
async function resolveExternalEntry(cat, item) {
  const entry = {};
  for (const key of PLDMGR_FIELDS) if (typeof item?.[key] === 'string') entry[key] = item[key].trim();
  try {
    for (const key of ['name', 'filename', 'url']) if (!entry[key]) fail(`missing "${key}"`);
    if (!/^https?:\/\//.test(entry.url)) fail('url must be http(s)');
    const fn = entry.filename;
    if (fn.includes('/') || fn.includes('..')) fail(`invalid filename "${fn}"`);
    if (!SUPPORTED_EXTENSIONS.includes(path.extname(fn).toLowerCase())) {
      fail(`"${fn}" is not one of ${SUPPORTED_EXTENSIONS.join(', ')}`);
    }

    const { checksum, size, modified } = await sha256OfUrl(entry.url);
    if (size === 0) fail('downloaded file is empty');
    if (entry.checksum && entry.checksum.toLowerCase() !== checksum) {
      fail(`checksum mismatch (catalog ${entry.checksum}, computed ${checksum})`);
    }
    entry.checksum = checksum;
    entry.category ||= 'Uncategorized';
    const rel = await githubReleaseOf(entry.url);
    if (rel) entry.release_type = rel.releaseType;
    const released = rel?.released ?? modified;
    if (released) entry.released = released;
    const homepage = cat.homepage ?? githubRepoPage(entry.url) ?? githubRepoPage(cat.url);
    if (homepage) entry.homepage = homepage;
    entry.catalog = cat.name;
    entry.catalog_url = cat.url;
    for (const [key, value] of Object.entries(entry)) checkValue('entry', key, value, LIMITS[key]);

    console.error(`  [${cat.name}] ${fn} ${entry.version ?? ''} (${size} bytes) sha256=${checksum}`);
    return entry;
  } catch (e) {
    if (!(e instanceof CatalogError)) throw e;
    warn(`skipping ${cat.name} / ${entry.name ?? '(unnamed)'}: ${e.message}`);
    return null;
  }
}

// ── pldmgr-compatible output ────────────────────────────────

function checkValue(id, key, value, limit) {
  if (UNSAFE_CHARS.test(value)) fail(`${id}: "${key}" contains a character pldmgr cannot parse ({ } " \\ or control): ${JSON.stringify(value)}`);
  // strstr would match a value that looks like a key before the real key.
  if (PAYLOAD_KEYS.includes(value)) fail(`${id}: "${key}" value "${value}" collides with a JSON key name`);
  if (limit && Buffer.byteLength(value, 'utf8') > limit) fail(`${id}: "${key}" is longer than pldmgr's ${limit}-byte limit`);
}

function buildEntry(p, up, nameById) {
  const requires = (p.requires ?? []).map((r) => nameById.get(r));
  let description = (p.description ?? '').trim();
  if (requires.length) description = `${description}${description ? ' ' : ''}Requires: ${requires.join(', ')}.`;

  const entry = {
    name: p.name.trim(),
    filename: p.filename ?? up.filename,
    url: up.url,
    description,
    version: p.version ?? up.version,
    category: p.category ?? 'Uncategorized',
    checksum: up.checksum,
  };
  if (requires.length) entry.requires = requires.join(', ');
  // Not used by pldmgr; the landing page links to it
  if (up.homepage) entry.homepage = up.homepage;
  // Not used by pldmgr; the landing page shows it as a badge (unknown for plain URL sources)
  if (up.releaseType) entry.release_type = up.releaseType;
  if (up.released) entry.released = up.released;

  const fn = entry.filename;
  if (!fn || fn.includes('/') || fn.includes('..')) fail(`${p.id}: invalid filename "${fn}"`);
  if (path.extname(fn).toLowerCase() !== p.extension) {
    fail(`${p.id}: "${fn}" does not have the expected ${p.extension} extension`);
  }
  if (!/^[0-9a-f]{64}$/.test(entry.checksum)) fail(`${p.id}: bad checksum "${entry.checksum}"`);
  for (const [key, value] of Object.entries(entry)) checkValue(p.id, key, value, LIMITS[key]);
  return entry;
}

// The empty guard object closes pldmgr's first '{'..'}' scan window before
// "payloads", so the top-level "name" is not mistaken for the first payload's
// name. sources_add still finds "name" ahead of the "payloads" key.
function render(sourceName, entries) {
  const s = JSON.stringify;
  const items = entries.map((e) => {
    const fields = Object.entries(e).map(([k, v]) => `      ${s(k)}: ${s(v)}`);
    return `    {\n${fields.join(',\n')}\n    }`;
  });
  return [
    '{',
    `  "name": ${s(sourceName)},`,
    `  "generated_at": ${s(new Date().toISOString())},`,
    '  "_pldmgr_parser_guard": {},',
    '  "payloads": [',
    items.join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(opts.catalog);

  const sourceName = catalog.name.trim();
  if (UNSAFE_CHARS.test(sourceName) || Buffer.byteLength(sourceName) > SOURCE_NAME_LIMIT) {
    fail(`top-level name must be <= ${SOURCE_NAME_LIMIT} bytes without { } " \\ or control characters`);
  }

  const ordered = orderByDependencies(catalog.payloads);
  const nameById = new Map(catalog.payloads.map((p) => [p.id, p.name.trim()]));

  const resolved = await Promise.all(
    ordered.map(async (p) => {
      const up = await resolvePayload(p);
      console.error(`  ${p.id}: ${up.filename} ${up.version} (${up.size} bytes) sha256=${up.checksum}`);
      return buildEntry(p, up, nameById);
    }),
  );

  const filenames = new Set();
  for (const e of resolved) {
    if (filenames.has(e.filename)) fail(`duplicate filename "${e.filename}"`);
    filenames.add(e.filename);
  }

  // External catalogs come after our own payloads, in catalog order
  for (const ext of catalog.external) {
    const cat = await loadExternal(ext);
    const entries = await Promise.all(cat.items.map((item) => resolveExternalEntry(cat, item)));
    for (const e of entries.filter(Boolean)) {
      if (filenames.has(e.filename)) {
        warn(`skipping ${cat.name} / ${e.name}: filename "${e.filename}" is already used`);
        continue;
      }
      filenames.add(e.filename);
      resolved.push(e);
    }
  }

  const out = render(sourceName, resolved);
  JSON.parse(out); // sanity check: must remain valid JSON

  if (opts.dryRun) {
    process.stdout.write(out);
    return;
  }
  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.resolve(path.dirname(opts.catalog), catalog.output ?? 'payloads.json');
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, outPath);
  console.error(`Wrote ${resolved.length} payloads to ${outPath}`);
}

main().catch((e) => {
  console.error(`error: ${e instanceof CatalogError ? e.message : e.stack}`);
  process.exit(1);
});
