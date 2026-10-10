function el(tag, props = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children.filter((c) => c != null));
  return n;
}

// Copies text; if the clipboard API is unavailable, shows the full text in the input selected instead
async function copy(text, input, onDone) {
  try {
    await navigator.clipboard.writeText(text);
    onDone();
  } catch {
    input.value = text;
    input.select();
  }
}

const srcUrl = new URL('payloads.json', location.href).href;
const src = document.getElementById('src');
src.value = srcUrl;
document.getElementById('copy').addEventListener('click', (e) => {
  copy(srcUrl, src, () => { e.target.textContent = 'Copied'; });
});

const COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg>';
const DONE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';

// Labelled read-only value with a copy button; `shown` may be shorter than the copied value
function copyField(label, value, id, shown = value) {
  const input = el('input', { id, type: 'text', readOnly: true, value: shown, title: value });
  const btn = el('button', { type: 'button', className: 'icon-btn', title: `Copy ${label}`, ariaLabel: `Copy ${label}` });
  btn.innerHTML = COPY_ICON;
  btn.addEventListener('click', () => copy(value, input, () => {
    btn.innerHTML = DONE_ICON;
    btn.classList.add('done');
    setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove('done'); }, 1500);
  }));
  return el('div', { className: 'field' }, el('label', { htmlFor: id, textContent: label }), input, btn);
}

// Short date like "8 Oct 2026"; the full local date and time on hover
function releasedDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return el('time', {
    className: 'released',
    dateTime: iso,
    title: d.toLocaleString(),
    textContent: `Released ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`,
  });
}

// Same look as the source URL row at the top of the page: wide input and a Copy button
function sourceRow(url, label) {
  const input = el('input', { type: 'text', readOnly: true, value: url, ariaLabel: label });
  const btn = el('button', { type: 'button', className: 'btn', textContent: 'Copy' });
  btn.addEventListener('click', () => copy(url, input, () => { btn.textContent = 'Copied'; }));
  return el('div', { className: 'source' }, input, btn);
}

function checksumField(sum, id) {
  return copyField('SHA-256', sum, id, `${sum.slice(0, 8)}...${sum.slice(-8)}`);
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function card(p) {
  const requires = p.requires ? p.requires.split(', ') : [];
  // The generator appends "Requires: …." for Payload Manager's UI; shown as chips here instead
  const description = requires.length ? p.description.replace(/\s*Requires: [^.]*\.$/, '') : p.description;

  // External entries get the catalog in their id, so names can't clash with ours
  const id = p.catalog ? `${slug(p.catalog)}-${slug(p.name)}` : slug(p.name);
  const inactive = p.release_type === 'inactive';
  return el('article', { className: inactive ? 'card inactive' : 'card', id },
    el('div', { className: 'top' },
      el('h2', { textContent: p.name }),
      el('span', { className: 'version' },
        p.version,
        p.release_type ? el('span', { className: `release ${p.release_type}`, textContent: p.release_type }) : null)),
    p.released ? releasedDate(p.released) : null,
    el('span', { className: 'category', textContent: p.category }),
    description ? el('p', { textContent: description }) : null,
    requires.length
      ? el('div', { className: 'requires' }, el('span', { textContent: 'Requires' }),
          ...requires.map((r) => el('a', { href: `#${slug(r)}`, textContent: r })))
      : null,
    // Inactive entries have no file to download, only the upstream link
    el('div', { className: 'foot' },
      inactive ? null : el('span', { className: 'file', textContent: p.filename }),
      el('span', { className: 'links' },
        inactive ? null : el('a', { href: p.url, textContent: 'Download' }),
        p.homepage ? el('a', { href: p.homepage, target: '_blank', rel: 'noopener', textContent: 'Upstream ↗' }) : null),
      inactive ? null : checksumField(p.checksum, `sum-${id}`)),
  );
}

fetch('payloads.json', { cache: 'no-cache' })
  .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then((data) => {
    const when = data.generated_at ? new Date(data.generated_at).toLocaleString() : 'unknown';
    const inactive = data.inactive ?? [];
    const counts = `${data.payloads.length} payloads${inactive.length ? ` (+${inactive.length} inactive)` : ''}`;
    document.getElementById('status').textContent = `${counts} · updated ${when}`;

    const own = [...data.payloads.filter((p) => !p.catalog), ...inactive];
    document.getElementById('list').append(...own.map(card));

    // Payloads included from other catalogs, one group per catalog
    const groups = new Map();
    for (const p of data.payloads.filter((x) => x.catalog)) {
      if (!groups.has(p.catalog)) groups.set(p.catalog, []);
      groups.get(p.catalog).push(p);
    }
    const external = document.getElementById('external');
    external.hidden = groups.size === 0;
    for (const [name, items] of groups) {
      external.append(
        el('div', { className: 'group-head' },
          el('h3', { textContent: name }),
          sourceRow(items[0].catalog_url, `${name} source URL`)),
        el('div', { className: 'grid' }, ...items.map(card)),
      );
    }
  })
  .catch((err) => { document.getElementById('status').textContent = `Could not load payloads.json (${err.message}).`; });
