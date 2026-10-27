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

// SHA-256 behind a small toggle; the panel floats above the card instead of pushing it around
function shaFlyout(sum, id) {
  return el('details', { className: 'sha' },
    el('summary', { textContent: 'SHA-256' }),
    el('div', { className: 'sha-panel' }, checksumField(sum, id)));
}

// One open fly-out at a time; a click anywhere else closes it
document.addEventListener('click', (e) => {
  for (const d of document.querySelectorAll('details.sha[open]')) if (!d.contains(e.target)) d.open = false;
});

function versionBadge(version, type) {
  return el('span', { className: 'version' },
    version,
    type ? el('span', { className: `release ${type}`, textContent: type }) : null);
}

// Several payloads of one project (e.g. fan_target's temperatures) on a single card
function groupCard(gid, group, members) {
  const first = members[0];
  const sameVersion = members.every((m) => m.version === first.version);
  return el('article', { className: 'card', id: slug(gid) },
    el('div', { className: 'top' },
      el('h2', { textContent: group.name }),
      sameVersion ? versionBadge(first.version, first.release_type) : null),
    first.last_update ? releasedDate(first.last_update) : null,
    el('span', { className: 'category', textContent: first.category }),
    group.description ? el('p', { textContent: group.description }) : null,
    el('div', { className: 'foot' },
      el('ul', { className: 'variants' }, ...members.map((m) => el('li', { id: slug(m.name) },
        el('span', { className: 'variant' },
          el('span', { className: 'label', textContent: m.variant }),
          el('span', { className: 'file', textContent: m.filename, title: m.filename })),
        el('a', { href: m.url, textContent: 'Download' }),
        m.checksum ? shaFlyout(m.checksum, `sum-${slug(m.name)}`) : el('span')))),
      first.source
        ? el('span', { className: 'links' }, el('a', { href: first.source, target: '_blank', rel: 'noopener', textContent: 'Upstream ↗' }))
        : null),
  );
}

// Cards for a list of entries; members of a group share one card where the first member would be
function cards(items, groups) {
  const out = [];
  const shown = new Set();
  for (const p of items) {
    if (!p.group || !groups[p.group]) {
      out.push(card(p));
    } else if (!shown.has(p.group)) {
      shown.add(p.group);
      out.push(groupCard(p.group, groups[p.group], items.filter((m) => m.group === p.group)));
    }
  }
  return out;
}

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
      versionBadge(p.version, p.release_type)),
    p.last_update ? releasedDate(p.last_update) : null,
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
        p.source ? el('a', { href: p.source, target: '_blank', rel: 'noopener', textContent: 'Upstream ↗' }) : null),
      inactive || !p.checksum ? null : shaFlyout(p.checksum, `sum-${id}`)),
  );
}

// ── Tabs ── the URL hash names the tab (#apps), or a card in it (#legacyjb)

const tabs = () => [...document.querySelectorAll('.tabs [role="tab"]')].filter((t) => !t.hidden);

function showTab(name, { focus = false } = {}) {
  for (const t of document.querySelectorAll('.tabs [role="tab"]')) {
    const selected = t.getAttribute('aria-controls') === name;
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focus) t.focus();
  }
}

// Opens the tab the hash points at; for a card, also scrolls to it
function followHash() {
  const target = location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  const panel = target?.closest('[role="tabpanel"]');
  const tab = panel && document.querySelector(`.tabs [aria-controls="${panel.id}"]`);
  if (!tab || tab.hidden) {
    showTab('main');
    return;
  }
  showTab(panel.id);
  if (target !== panel) target.scrollIntoView({ block: 'start' });
}

function setUpTabs(counts) {
  for (const [name, n] of Object.entries(counts)) {
    const tab = document.getElementById(`tab-${name}`);
    tab.querySelector('.count').textContent = n ? String(n) : '';
    tab.hidden = name !== 'main' && n === 0;
    tab.addEventListener('click', () => {
      history.replaceState(null, '', `#${name}`);
      showTab(name);
    });
  }
  // Arrow keys, Home and End move between tabs, as in other tab lists
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    const list = tabs();
    const i = list.indexOf(document.activeElement);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (i < 0 || next === undefined) return;
    e.preventDefault();
    const tab = list[(next + list.length) % list.length];
    history.replaceState(null, '', `#${tab.getAttribute('aria-controls')}`);
    showTab(tab.getAttribute('aria-controls'), { focus: true });
  });
  window.addEventListener('hashchange', followHash);
  followHash();
}

fetch('payloads.json', { cache: 'no-cache' })
  .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then((data) => {
    const when = data.generated_at ? new Date(data.generated_at).toLocaleString() : 'unknown';
    const inactive = data.inactive ?? [];
    // Apps as listed on the Apps tab: a group of variants counts once
    const apps = new Set((data.downloads ?? []).map((d) => d.group ?? d.name)).size;
    const extras = [apps && `${apps} app${apps === 1 ? '' : 's'}`, inactive.length && `${inactive.length} inactive`].filter(Boolean);
    const counts = `${data.payloads.length} payloads${extras.length ? ` (+${extras.join(', ')})` : ''}`;
    document.getElementById('status').textContent = `${counts} · updated ${when}`;

    const cardGroups = data.groups ?? {};
    const own = data.payloads.filter((p) => !p.catalog);
    const ownCards = cards(own, cardGroups);
    document.getElementById('list').append(...ownCards);

    // Site-only downloads (apps); they use "file" and "download" so Payload Manager skips them
    const downloads = (data.downloads ?? []).map((d) => ({ ...d, filename: d.file, url: d.download }));
    const appCards = cards(downloads, cardGroups);
    document.getElementById('downloads-list').append(...appCards);

    const links = data.links ?? [];
    document.getElementById('links-list').append(...links.map((l) => el('li', {},
      el('a', { href: l.href, target: '_blank', rel: 'noopener', textContent: `${l.name} ↗` }),
      l.description ? el('p', { textContent: l.description }) : null)));

    // Disabled entries
    document.getElementById('inactive-list').append(...inactive.map(card));

    // Payloads included from other catalogs, one group per catalog
    const groups = new Map();
    for (const p of data.payloads.filter((x) => x.catalog)) {
      if (!groups.has(p.catalog)) groups.set(p.catalog, []);
      groups.get(p.catalog).push(p);
    }
    const external = document.getElementById('other');
    for (const [name, items] of groups) {
      external.append(
        el('div', { className: 'group-head' },
          el('h3', { textContent: name }),
          sourceRow(items[0].catalog_url, `${name} source URL`)),
        el('div', { className: 'grid' }, ...items.map(card)),
      );
    }

    setUpTabs({
      main: ownCards.length,
      apps: appCards.length,
      other: data.payloads.length - own.length,
      links: links.length,
      inactive: inactive.length,
    });
  })
  .catch((err) => { document.getElementById('status').textContent = `Could not load payloads.json (${err.message}).`; });
