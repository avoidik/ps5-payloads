#!/usr/bin/env node
// Checks a payloads.json with PS5 Payload Manager's own code. Its unmodified source
// handling (sources.c, repository.c, ...) is built together with harness.c, and then:
//   1. the file is added as a source over HTTP, like on the console (sources_add);
//   2. the list its web UI receives is checked field by field;
//   3. every payload is installed: downloaded, checksum-verified, and written to disk.
//
// Usage: node tools/pldmgr-verify/verify.mjs [payloads.json]
// Needs git, gcc, python3, libcurl headers and the system CA bundle.

import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Payload Manager release to test against; bump deliberately
const PLDMGR_REPO = 'https://github.com/itsPLK/ps5-payload-manager.git';
const PLDMGR_REF = 'v0.5.2';
const CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
const LIST_FIELDS = ['name', 'filename', 'url', 'description', 'version', 'category'];
const PLDMGR_SOURCES = ['sources.c', 'repository.c', 'json_helpers.c', 'utils.c', 'sha256.c'];

const here = path.dirname(new URL(import.meta.url).pathname);
const jsonFile = path.resolve(process.argv[2] ?? 'payloads.json');
const doc = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pldmgr-verify-'));
const dataRoot = path.join(work, 'data');
const problems = [];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts });

function build() {
  const pm = path.join(work, 'pldmgr');
  const gen = path.join(work, 'gen');
  run('git', ['-c', 'advice.detachedHead=false', 'clone', '-q', '--depth', '1', '--branch', PLDMGR_REF, PLDMGR_REPO, pm]);
  console.log(`Payload Manager ${PLDMGR_REF}`);
  fs.mkdirSync(gen);

  // CA bundle header, made with Payload Manager's own asset tool
  if (!fs.existsSync(CA_BUNDLE)) throw new Error(`CA bundle not found at ${CA_BUNDLE}`);
  run('python3', [path.join(pm, 'tools/gen_assets.py'), CA_BUNDLE, path.join(gen, 'assets_cacert_pem.h'), 'cacert_pem']);

  // pldmgr.h hard-codes /data/pldmgr; a copy points it into the work dir instead
  const header = fs.readFileSync(path.join(pm, 'include/pldmgr.h'), 'utf8');
  if (!header.includes('"/data/pldmgr')) throw new Error("pldmgr.h no longer uses /data/pldmgr; update verify.mjs");
  fs.writeFileSync(path.join(gen, 'pldmgr.h'), header.replaceAll('"/data/pldmgr', 'PLDMGR_TEST_ROOT "/pldmgr'));

  const flags = [`-DPLDMGR_TEST_ROOT="${dataRoot}"`, `-I${gen}`, `-I${path.join(pm, 'include')}`];
  const objects = [];
  const compile = (src, warnings) => {
    const obj = path.join(work, `${path.basename(src, '.c')}.o`);
    run('gcc', ['-c', ...warnings, ...flags, src, '-o', obj]);
    objects.push(obj);
  };
  compile(path.join(here, 'harness.c'), ['-Wall', '-Wextra']);
  for (const f of PLDMGR_SOURCES) compile(path.join(pm, 'src', f), ['-w']); // their code, their warnings
  const bin = path.join(work, 'harness');
  run('gcc', [...objects, '-lcurl', '-o', bin]);
  return bin;
}

// Serves payloads.json over HTTP, since Payload Manager only accepts HTTP 200 responses
function serve() {
  const body = fs.readFileSync(jsonFile);
  const server = http.createServer((req, res) => {
    if (req.url === '/payloads.json') res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
    else res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Must not block: the HTTP server above runs on this process's event loop
function harness(bin, ...args) {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf8', maxBuffer: 4 << 20, timeout: 300_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout.trim(), log: stderr.trim() });
    });
  });
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry.name === name) return p;
  }
  return null;
}

async function main() {
  const bin = build();
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/payloads.json`;

  try {
    // 1. Add the source
    const add = await harness(bin, 'add', url);
    if (!add.ok) problems.push(`adding the source failed: ${add.out}`);
    else if (add.out !== doc.name) problems.push(`source added as "${add.out}", expected "${doc.name}"`);
    console.log(`add source: ${add.ok ? `ok, named "${add.out}"` : 'FAILED'}`);
    if (!add.ok) return;

    // 2. The list the web UI receives
    const list = await harness(bin, 'list');
    let source;
    try {
      source = JSON.parse(list.out).sources.find((s) => s.id !== 'default');
    } catch (e) {
      problems.push(`web UI list is not valid JSON: ${e.message}`);
      return;
    }
    if (!source || source.error) {
      problems.push('source missing from the web UI list, or marked as failed');
      return;
    }
    if (source.payloads.length !== doc.payloads.length) {
      problems.push(`web UI lists ${source.payloads.length} payloads, file has ${doc.payloads.length}`);
    }
    doc.payloads.forEach((p, i) => {
      for (const key of LIST_FIELDS) {
        const got = source.payloads[i]?.[key];
        if ((p[key] ?? '') !== got) problems.push(`${p.name}: "${key}" read as ${JSON.stringify(got)}, expected ${JSON.stringify(p[key])}`);
      }
    });
    console.log(`web UI list: ${source.payloads.length} payloads`);

    // 3. Install every payload
    const folders = new Map();
    for (const p of doc.payloads) {
      const fail = (why) => {
        problems.push(`${p.name}: ${why}`);
        console.log(`install ${p.name}: FAILED (${why})`);
      };
      // The HTTP handler's filename check (is_safe_filename in http_server.c)
      if (!p.filename || p.filename.includes('/') || p.filename.includes('..')) { fail('filename rejected'); continue; }
      // Only these can be launched (is_supported_extension in payload_mgr.c)
      if (!/\.(elf|bin)$/i.test(p.filename)) { fail('not an .elf or .bin file'); continue; }

      const res = await harness(bin, 'install', p.filename, source.id);
      if (!res.ok) { fail(res.out); continue; }
      const file = findFile(path.join(dataRoot, 'pldmgr/payloads'), p.filename);
      if (!file) { fail('installed file not found'); continue; }
      const folder = path.basename(path.dirname(file));
      if (folders.has(folder)) { fail(`installs into the same folder as ${folders.get(folder)} ("${folder}")`); continue; }
      folders.set(folder, p.name);

      // The metadata file must carry the checksum, or Payload Manager skipped verification
      const meta = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
      const sum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (meta.checksum !== p.checksum) { fail(`checksum recorded as "${meta.checksum}"`); continue; }
      if (sum !== p.checksum) { fail('installed file does not match the checksum'); continue; }
      console.log(`install ${p.name}: ok (folder ${folder})`);
    }
  } finally {
    server.close();
  }
}

try {
  await main();
} catch (e) {
  problems.push(e.message);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

if (problems.length) {
  for (const p of problems) console.log(`problem: ${p}`);
  process.exit(1);
}
console.log(`Payload Manager ${PLDMGR_REF} can process ${path.basename(jsonFile)}`);
