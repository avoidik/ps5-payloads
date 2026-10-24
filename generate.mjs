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
import { unzipSync } from 'fflate';
import { load as loadYaml } from 'js-yaml';

// Field buffer sizes in pldmgr's RepoPayload struct, minus the NUL terminator. Longer
// values make pldmgr (0.6+) reject the entry; only description is truncated instead.
const LIMITS = {
  id: 127, name: 127, filename: 255, url: 1023, description: 1023, version: 63, category: 127,
  last_update: 63, source: 1023, author: 127, details_url: 1023,
};
const SOURCE_NAME_LIMIT = 255;
// Payload ids name pldmgr's install slots (repo/<id>@<source>), so they must stay stable
const ID_PATTERN = /^[a-z0-9._-]+$/;
// Fields taken from external catalogs; anything else they carry is dropped
const PLDMGR_FIELDS = [
  'id', 'name', 'filename', 'url', 'description', 'version', 'category', 'checksum',
  'last_update', 'source', 'author', 'details_url',
];
const RELEASES_PER_PAGE = 100; // GitHub's maximum
// pldmgr only launches these (is_supported_extension in payload_mgr.c)
const SUPPORTED_EXTENSIONS = ['.elf', '.bin'];
// payload: offered in Payload Manager; download: listed on the site only (apps, archives)
const KINDS = ['payload', 'download'];

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

  if (doc.base_url !== undefined) {
    if (typeof doc.base_url !== 'string' || !/^https?:\/\//.test(doc.base_url)) fail(`${file}: "base_url" must be an http(s) URL`);
    if (!doc.base_url.endsWith('/')) doc.base_url += '/';
  }

  // Payloads shown together on one site card: { <group id>: { name, description? } }
  doc.groups ??= {};
  if (typeof doc.groups !== 'object' || Array.isArray(doc.groups)) fail(`${file}: "groups" must be a mapping`);
  for (const [gid, g] of Object.entries(doc.groups)) {
    if (!ID_PATTERN.test(gid)) fail(`groups.${gid}: group ids use only a-z, 0-9, ".", "_" and "-"`);
    if (!g || typeof g.name !== 'string' || !g.name.trim()) fail(`groups.${gid}: "name" is required`);
    if (g.description !== undefined && typeof g.description !== 'string') fail(`groups.${gid}: "description" must be a string`);
  }

  // Useful links for the site: { name, url | repo, description? }
  doc.links ??= [];
  if (!Array.isArray(doc.links)) fail(`${file}: "links" must be a list`);
  doc.links.forEach((l, i) => {
    if (!l || typeof l.name !== 'string' || !l.name.trim()) fail(`links[${i}]: "name" is required`);
    if ((l.url === undefined) === (l.repo === undefined)) fail(`links[${i}]: set exactly one of "url" or "repo"`);
    if (l.url !== undefined && (typeof l.url !== 'string' || !/^https?:\/\//.test(l.url))) fail(`links[${i}]: "url" must be an http(s) URL`);
    if (l.repo !== undefined && (typeof l.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(l.repo))) fail(`links[${i}]: "repo" must be "owner/name"`);
    if (l.description !== undefined && typeof l.description !== 'string') fail(`links[${i}]: "description" must be a string`);
  });

  doc.external ??= [];
  if (!Array.isArray(doc.external)) fail(`${file}: "external" must be a list`);
  doc.external.forEach((c, i) => {
    if (!c || typeof c.url !== 'string' || !/^https?:\/\//.test(c.url)) fail(`external[${i}]: "url" must be an http(s) URL`);
    if (typeof c.name !== 'string' || !c.name.trim()) fail(`external[${i}]: "name" is required`);
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
    if (!ID_PATTERN.test(p.id) || p.id.length > LIMITS.id) fail(`${where}: "id" must use only a-z, 0-9, ".", "_" and "-"`);
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') fail(`${where}: "enabled" must be true or false`);
    p.kind ??= 'payload';
    if (!KINDS.includes(p.kind)) fail(`${where}: "kind" must be one of ${KINDS.join(', ')}`);
    if (p.kind === 'payload' && !SUPPORTED_EXTENSIONS.includes(p.extension)) {
      fail(`${where}: "extension" must be one of ${SUPPORTED_EXTENSIONS.join(', ')}`);
    }
    if (p.kind === 'download' && !(typeof p.extension === 'string' && /^\.[a-z0-9]+$/i.test(p.extension))) {
      fail(`${where}: "extension" must be a file extension like .zip`);
    }
    ids.add(p.id);

    if (p.group !== undefined) {
      if (p.kind !== 'payload') fail(`${where}: only payloads can be in a group`);
      if (!Object.hasOwn(doc.groups, p.group)) fail(`${where}: unknown group "${p.group}"`);
      if (typeof p.variant !== 'string' || !p.variant.trim()) fail(`${where}: "variant" is required for group members`);
    } else if (p.variant !== undefined) {
      fail(`${where}: "variant" only applies to group members`);
    }
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
    if (src.extract !== undefined) {
      if (p.kind !== 'payload') fail(`${where}: source.extract only applies to payloads`);
      if (typeof src.extract !== 'string' || !src.extract || src.extract.includes('/')) fail(`${where}: source.extract must be a file name`);
      if (!doc.base_url) fail(`${where}: source.extract needs a top-level "base_url" to host the extracted file`);
    }
  });

  for (const p of doc.payloads) {
    for (const r of p.requires ?? []) {
      if (!ids.has(r)) fail(`${p.id}: requires unknown id "${r}"`);
      if (doc.payloads.find((x) => x.id === r).kind !== 'payload') fail(`${p.id}: requires "${r}", which is not a payload`);
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
  return { checksum: hash.digest('hex'), size, modified: lastModifiedOf(res) };
}

// Release date fallback for files that don't come from a GitHub release lookup
function lastModifiedOf(res) {
  const t = Date.parse(res.headers.get('last-modified') ?? '');
  return Number.isNaN(t) ? null : new Date(t).toISOString().replace('.000Z', 'Z');
}

// Archives are read whole so a file can be extracted from them
async function downloadBytes(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'ps5-payloads-generator' } });
  if (!res.ok) fail(`download failed (HTTP ${res.status}): ${url}`);
  const data = Buffer.from(await res.arrayBuffer());
  return { data, checksum: sha256(data), size: data.length, modified: lastModifiedOf(res) };
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Takes one file out of a zip archive; it's then hosted with the site under files/
function extractFile(p, up, archive, baseUrl) {
  const name = p.source.extract;
  const isSums = (n) => /sha256sums/i.test(path.basename(n));
  let files;
  try {
    files = unzipSync(archive, { filter: (f) => path.basename(f.name) === name || isSums(f.name) });
  } catch (e) {
    fail(`${p.id}: cannot read ${up.filename} as a zip archive: ${e.message}`);
  }
  const matches = Object.keys(files).filter((n) => path.basename(n) === name);
  if (matches.length !== 1) fail(`${p.id}: ${up.filename} has ${matches.length ? 'several files' : 'no file'} named "${name}"`);
  const data = Buffer.from(files[matches[0]]);
  if (data.length === 0) fail(`${p.id}: ${name} in ${up.filename} is empty`);
  const checksum = sha256(data);

  // Cross-check against the archive's own checksum list, when it has one
  for (const [n, list] of Object.entries(files).filter(([f]) => isSums(f))) {
    const line = Buffer.from(list).toString('utf8').split('\n').map((l) => l.trim().split(/\s+\*?/))
      .find(([, f]) => f && path.basename(f) === name);
    if (line && line[0].toLowerCase() !== checksum) fail(`${p.id}: ${name} does not match ${path.basename(n)} in ${up.filename}`);
  }
  return { ...up, archive: up.filename, filename: name, url: `${baseUrl}files/${name}`, checksum, size: data.length, hosted: data };
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

async function resolvePayload(p, baseUrl) {
  const up = p.source.type === 'github' ? await resolveGithub(p) : resolveUrl(p);
  const extract = p.source.extract;
  const { checksum, size, modified, data } = extract ? await downloadBytes(up.url) : await sha256OfUrl(up.url);
  if (size === 0) fail(`${p.id}: downloaded file is empty: ${up.url}`);
  if (up.size != null && size !== up.size) fail(`${p.id}: size mismatch for ${up.url} (expected ${up.size}, got ${size})`);
  if (up.digest && up.digest !== checksum) fail(`${p.id}: checksum mismatch for ${up.url} (GitHub ${up.digest}, computed ${checksum})`);
  // Direct URLs: use the GitHub release they point at, else the server's Last-Modified
  const rel = up.released ? null : await githubReleaseOf(up.url);
  const resolved = { ...up, ...rel, checksum, size, released: up.released ?? rel?.released ?? modified };
  return extract ? extractFile(p, resolved, data, baseUrl) : resolved;
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
    // Prefixed with the catalog, so ids can't clash with ours inside this source
    entry.id = `${slug(cat.name)}.${ID_PATTERN.test(entry.id ?? '') ? entry.id : slug(entry.name)}`;
    const rel = await githubReleaseOf(entry.url);
    if (rel) entry.release_type = rel.releaseType;
    entry.last_update ||= rel?.released ?? modified ?? undefined;
    entry.source ||= cat.homepage ?? githubRepoPage(entry.url) ?? githubRepoPage(cat.url) ?? undefined;
    for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];
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
  if (limit && Buffer.byteLength(value, 'utf8') > limit) fail(`${id}: "${key}" is longer than pldmgr's ${limit}-byte limit`);
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

function buildEntry(p, up, nameById) {
  const requires = (p.requires ?? []).map((r) => nameById.get(r));
  let description = (p.description ?? '').trim();
  if (requires.length) description = `${description}${description ? ' ' : ''}Requires: ${requires.join(', ')}.`;

  const entry = {
    id: p.id,
    name: p.name.trim(),
    filename: p.filename ?? up.filename,
    url: up.url,
    description,
    version: p.version ?? up.version,
    category: p.category ?? 'Uncategorized',
    checksum: up.checksum,
  };
  if (requires.length) entry.requires = requires.join(', ');
  // Upstream project page; pldmgr links to it and so does the landing page
  if (up.homepage) entry.source = up.homepage;
  // Release date; pldmgr uses it to break ties between equal versions
  if (up.released) entry.last_update = up.released;
  // Not used by pldmgr; the landing page shows it as a badge (unknown for plain URL sources)
  if (up.releaseType) entry.release_type = up.releaseType;
  // Not used by pldmgr; the landing page shows a group's members on one card
  if (p.group) Object.assign(entry, { group: p.group, variant: p.variant.trim() });

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
// Disabled entries are listed for the site only. Payload Manager's parser skips any
// object without "filename" and "url", so these can't be installed from the source.
function buildInactiveEntry(p, nameById) {
  const requires = (p.requires ?? []).map((r) => nameById.get(r));
  const entry = { name: p.name.trim(), description: (p.description ?? '').trim(), category: p.category ?? 'Uncategorized' };
  if (p.version) entry.version = p.version;
  if (requires.length) entry.requires = requires.join(', ');
  const homepage = p.source.type === 'github' ? `https://github.com/${p.source.repo}` : p.source.homepage;
  if (homepage) entry.source = homepage;
  entry.release_type = 'inactive';
  for (const [key, value] of Object.entries(entry)) checkValue(p.id, key, value, LIMITS[key]);
  return entry;
}

// Site-only downloads (apps, archives). They use "file" and "download" instead of
// "filename" and "url", so Payload Manager's parser skips them.
function buildDownloadEntry(p, up) {
  const entry = {
    name: p.name.trim(),
    file: p.filename ?? up.filename,
    download: up.url,
    description: (p.description ?? '').trim(),
    version: p.version ?? up.version,
    category: p.category ?? 'Uncategorized',
    checksum: up.checksum,
  };
  if (up.homepage) entry.source = up.homepage;
  if (up.released) entry.last_update = up.released;
  if (up.releaseType) entry.release_type = up.releaseType;
  if (path.extname(entry.file).toLowerCase() !== p.extension.toLowerCase()) {
    fail(`${p.id}: "${entry.file}" does not have the expected ${p.extension} extension`);
  }
  for (const [key, value] of Object.entries(entry)) checkValue(p.id, key, value, LIMITS[key]);
  return entry;
}

// Site-only links. "href" instead of "url" and no "filename", so Payload Manager skips them.
async function resolveLink(l) {
  const link = { name: l.name.trim(), href: l.url ?? `https://github.com/${l.repo}` };
  let description = l.description?.trim();
  if (!description && l.repo) description = (await githubGet(`https://api.github.com/repos/${l.repo}`)).description?.trim();
  if (description) link.description = description;
  return link;
}

function render(sourceName, entries, inactive, downloads, links, groups, filesUrl) {
  const s = JSON.stringify;
  const items = (list) => list.map((e) => {
    const fields = Object.entries(e).map(([k, v]) => `      ${s(k)}: ${s(v)}`);
    return `    {\n${fields.join(',\n')}\n    }`;
  }).join(',\n');
  return [
    '{',
    `  "name": ${s(sourceName)},`,
    `  "generated_at": ${s(new Date().toISOString())},`,
    // Where extracted files are hosted; lets the verifier serve them locally before deploy
    ...(filesUrl ? [`  "files_url": ${s(filesUrl)},`] : []),
    // Before "payloads": Payload Manager only scans from that key onwards
    ...(Object.keys(groups).length ? [`  "groups": ${s(groups)},`] : []),
    '  "payloads": [',
    items(entries),
    // After "payloads": tools that read only that list, like Payload Manager, ignore these
    ...(inactive.length ? ['  ],', '  "inactive": [', items(inactive)] : []),
    ...(downloads.length ? ['  ],', '  "downloads": [', items(downloads)] : []),
    ...(links.length ? ['  ],', '  "links": [', items(links)] : []),
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
  if (Buffer.byteLength(sourceName) > SOURCE_NAME_LIMIT) fail(`top-level name must be <= ${SOURCE_NAME_LIMIT} bytes`);

  // Disabled entries are validated above but never looked up or downloaded
  const active = catalog.payloads.filter((p) => p.enabled !== false);
  const activeIds = new Set(active.map((p) => p.id));
  for (const p of catalog.payloads) if (!activeIds.has(p.id)) console.error(`  ${p.id}: disabled, skipped`);
  for (const p of active) {
    for (const r of p.requires ?? []) if (!activeIds.has(r)) fail(`${p.id}: requires "${r}", which is disabled`);
  }

  const ordered = orderByDependencies(active.filter((p) => p.kind === 'payload'));
  const nameById = new Map(catalog.payloads.map((p) => [p.id, p.name.trim()]));

  const hosted = [];
  const resolved = await Promise.all(
    ordered.map(async (p) => {
      const up = await resolvePayload(p, catalog.base_url);
      const from = up.archive ? ` from ${up.archive}` : '';
      console.error(`  ${p.id}: ${up.filename}${from} ${up.version} (${up.size} bytes) sha256=${up.checksum}`);
      if (up.hosted) hosted.push({ name: up.filename, data: up.hosted });
      return buildEntry(p, up, nameById);
    }),
  );
  const downloads = await Promise.all(
    active.filter((p) => p.kind === 'download').map(async (p) => {
      const up = await resolvePayload(p);
      console.error(`  ${p.id}: ${up.filename} ${up.version} (${up.size} bytes, site download) sha256=${up.checksum}`);
      return buildDownloadEntry(p, up);
    }),
  );

  const filenames = new Set();
  const ids = new Set(resolved.map((e) => e.id));
  for (const e of resolved) {
    if (filenames.has(e.filename)) fail(`duplicate filename "${e.filename}"`);
    filenames.add(e.filename);
  }

  // External catalogs come after our own payloads, in catalog order
  for (const ext of catalog.external) {
    const cat = await loadExternal(ext);
    const entries = await Promise.all(cat.items.map((item) => resolveExternalEntry(cat, item)));
    for (const e of entries.filter(Boolean)) {
      if (filenames.has(e.filename) || ids.has(e.id)) {
        warn(`skipping ${cat.name} / ${e.name}: ${filenames.has(e.filename) ? `filename "${e.filename}"` : `id "${e.id}"`} is already used`);
        continue;
      }
      filenames.add(e.filename);
      ids.add(e.id);
      resolved.push(e);
    }
  }

  // Payload Manager rejects a source without payloads
  if (resolved.length === 0) fail('no enabled payloads to write');

  const inactive = catalog.payloads.filter((p) => !activeIds.has(p.id)).map((p) => buildInactiveEntry(p, nameById));
  const filesUrl = hosted.length ? `${catalog.base_url}files/` : null;
  const links = await Promise.all(catalog.links.map(resolveLink));
  // Only groups that have a published member
  const groups = {};
  for (const e of resolved) {
    if (e.group && !groups[e.group]) {
      const g = catalog.groups[e.group];
      groups[e.group] = { name: g.name.trim(), ...(g.description ? { description: g.description.trim() } : {}) };
    }
  }
  const out = render(sourceName, resolved, inactive, downloads, links, groups, filesUrl);
  JSON.parse(out); // sanity check: must remain valid JSON

  if (opts.dryRun) {
    process.stdout.write(out);
    return;
  }
  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.resolve(path.dirname(opts.catalog), catalog.output ?? 'payloads.json');
  // Extracted files, published with the site; rewritten from scratch so nothing stale remains
  const filesDir = path.join(path.dirname(outPath), 'files');
  fs.rmSync(filesDir, { recursive: true, force: true });
  if (hosted.length) {
    fs.mkdirSync(filesDir);
    for (const f of hosted) fs.writeFileSync(path.join(filesDir, f.name), f.data);
  }

  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, outPath);
  const extra = [hosted.length && `${hosted.length} files to ${filesDir}`, downloads.length && `${downloads.length} site downloads`].filter(Boolean);
  console.error(`Wrote ${resolved.length} payloads to ${outPath}${extra.length ? ` (plus ${extra.join(', ')})` : ''}`);
}

main().catch((e) => {
  console.error(`error: ${e instanceof CatalogError ? e.message : e.stack}`);
  process.exit(1);
});
