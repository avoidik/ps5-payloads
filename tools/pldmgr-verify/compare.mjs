// Compares what Payload Manager's parser read (from check.c) with the real JSON values.
// Usage: node compare.mjs <payloads.json> <work dir>

import fs from 'node:fs';
import path from 'node:path';

const FIELDS = ['name', 'filename', 'url', 'description', 'version', 'category', 'checksum'];

const [jsonFile, dir] = process.argv.slice(2);
const doc = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const problems = [];

const sourceName = read('source_name.txt');
if (sourceName !== doc.name) problems.push(`source name read as "${sourceName}", expected "${doc.name}"`);

const parsed = read('parsed.tsv').split('\n').filter(Boolean).map((line) => line.split('\t'));
if (parsed.length !== doc.payloads.length) {
  problems.push(`parser found ${parsed.length} payloads, file has ${doc.payloads.length}`);
}
doc.payloads.forEach((p, i) => {
  FIELDS.forEach((key, j) => {
    const got = parsed[i]?.[j];
    if ((p[key] ?? '') !== got) problems.push(`${p.name}: "${key}" read as ${JSON.stringify(got)}, expected ${JSON.stringify(p[key])}`);
  });
});

try {
  const list = JSON.parse(read('list.json'));
  const listed = list.sources[0].payloads.map((p) => p.name);
  const expected = doc.payloads.map((p) => p.name);
  if (listed.join('\n') !== expected.join('\n')) problems.push(`web UI list has ${listed.join(', ')}`);
} catch (e) {
  problems.push(`web UI list is not valid JSON: ${e.message}`);
}

if (problems.length) {
  for (const p of problems) console.log(`compare: ${p}`);
  process.exit(1);
}
console.log(`compare: all ${doc.payloads.length * FIELDS.length} fields read correctly; web UI list is valid`);
