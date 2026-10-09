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

function checksumField(sum, id) {
  const input = el('input', { id, readOnly: true, value: `${sum.slice(0, 8)}...${sum.slice(-8)}`, title: sum });
  const btn = el('button', { type: 'button', className: 'icon-btn', title: 'Copy full SHA-256', ariaLabel: 'Copy full SHA-256' });
  btn.innerHTML = COPY_ICON;
  btn.addEventListener('click', () => copy(sum, input, () => {
    btn.innerHTML = DONE_ICON;
    btn.classList.add('done');
    setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove('done'); }, 1500);
  }));
  return el('div', { className: 'sum' }, el('label', { htmlFor: id, textContent: 'SHA-256' }), input, btn);
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function card(p) {
  const requires = p.requires ? p.requires.split(', ') : [];
  // The generator appends "Requires: …." for Payload Manager's UI; shown as chips here instead
  const description = requires.length ? p.description.replace(/\s*Requires: [^.]*\.$/, '') : p.description;

  return el('article', { className: 'card', id: slug(p.name) },
    el('div', { className: 'top' },
      el('h2', { textContent: p.name }),
      el('span', { className: 'version' },
        p.version,
        p.release_type ? el('span', { className: `release ${p.release_type}`, textContent: p.release_type }) : null)),
    el('span', { className: 'category', textContent: p.category }),
    description ? el('p', { textContent: description }) : null,
    requires.length
      ? el('div', { className: 'requires' }, el('span', { textContent: 'Requires' }),
          ...requires.map((r) => el('a', { href: `#${slug(r)}`, textContent: r })))
      : null,
    el('div', { className: 'foot' },
      el('span', { className: 'file', textContent: p.filename }),
      el('span', { className: 'links' },
        el('a', { href: p.url, textContent: 'Download' }),
        p.homepage ? el('a', { href: p.homepage, target: '_blank', rel: 'noopener', textContent: 'Upstream ↗' }) : null),
      checksumField(p.checksum, `sum-${slug(p.name)}`)),
  );
}

fetch('payloads.json', { cache: 'no-cache' })
  .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then((data) => {
    const when = data.generated_at ? new Date(data.generated_at).toLocaleString() : 'unknown';
    document.getElementById('status').textContent = `${data.payloads.length} payloads · updated ${when}`;
    document.getElementById('list').append(...data.payloads.map(card));
  })
  .catch((err) => { document.getElementById('status').textContent = `Could not load payloads.json (${err.message}).`; });
