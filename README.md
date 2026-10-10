# PS5 Payloads

A custom payload source for [PS5 Payload Manager](https://github.com/itsPLK/ps5-payload-manager).
The payloads are listed in `catalog.yaml`. `generate.mjs` turns that list into `payloads.json`, the file you add to Payload Manager under **Settings → Manage Sources**.

## Usage

```sh
npm install
npm run build                      # writes payloads.json
node generate.mjs --dry-run        # print the result without writing it
node generate.mjs other.yaml --out dist/payloads.json
npm run lint                       # ESLint (also runs in CI before generating)
```

For each GitHub entry, the generator:

1. looks up the most recently published release that has an asset matching `source.asset`, or the release named in `source.tag`. Pre-releases are skipped unless the entry sets `source.prerelease: true`;
2. downloads the asset and computes its SHA-256 checksum;
3. compares that checksum against GitHub's own `digest` for the asset, and the size against the published size.

The script doesn't write anything if any of these steps fails. Set `GITHUB_TOKEN` to avoid API rate limits.

To leave an entry out temporarily, for example while it's broken upstream, set `enabled: false` on it in `catalog.yaml`. It isn't looked up or downloaded, and Payload Manager no longer offers it. The site still lists it with an **inactive** badge and its upstream link but no download. That entry lives in a separate `inactive` list in `payloads.json`, without a file or URL, so Payload Manager's parser skips it. An enabled entry can't `require` a disabled one.

## Dependencies

`requires: [other-id]` lists payloads that must be loaded first. Payload Manager has no dependency field, so the generator does three things instead:

- puts dependencies earlier in the list;
- appends `Requires: <Name>.` to the description;
- adds a `requires` string field, which Payload Manager ignores.

## External catalogs

Projects that publish their own Payload Manager `payloads.json` can be included as they are, under `external:` in `catalog.yaml`:

```yaml
external:
  - name: Orbit Store
    url: https://raw.githubusercontent.com/saawant12/orbit-store-ps5/refs/heads/main/payloads.json
```

Their payloads are added after ours, tagged with the catalog's `name`, and the site shows them in a separate "From other catalogs" section. Each file is still downloaded and SHA-256 checked, and must match the catalog's own checksum if it gives one. Entries that aren't `.elf`/`.bin`, fail a check, or reuse a filename are skipped with a warning. A catalog that can't be downloaded fails the build.

## Why the output looks the way it does

Payload Manager doesn't use a real JSON parser. It reads from each `{` to the next `}` and finds keys by plain substring search. That leads to these rules for the output:

- **`_pldmgr_parser_guard: {}`:** without it, the source's top-level `"name"` and the first payload end up in the same `{…}` span, and the first payload is shown under the source's name. The empty object ends that span early.
- **Allowed characters:** values can't contain `{`, `}`, `"`, `\` or control characters. Lengths are capped at the sizes of pldmgr's buffers. The generator rejects values that break these rules instead of letting them be corrupted silently.
- **Checksums are required:** pldmgr retries downloads without certificate checks when TLS verification fails, so the checksum is the only thing that confirms the payload is genuine.

## Hosting

The workflow publishes `payloads.json` and a small landing page (`site/index.html`, which lists the payloads) to GitHub Pages:

- Source URL: `https://avoidik.github.io/ps5-payloads/payloads.json`
- Landing page: `https://avoidik.github.io/ps5-payloads/`

One-time setup: in the repository's **Settings → Pages**, set **Source** to **GitHub Actions**.

Payload Manager downloads the file from the console itself, so you don't need CORS headers.

## CI

`.github/workflows/generate.yml` runs the generator and deploys the site:

- **Pushes to `main`** that touch the catalog, the generator, the npm files or `site/`: regenerates `payloads.json`, commits it if any payload changed, and deploys to Pages.
- **Every 6 hours** (at :17 past 00, 06, 12 and 18 UTC): picks up new upstream releases, then commits and deploys the same way.
- **Manual run:** from the Actions tab (`workflow_dispatch`).
- **Pull requests:** check that the catalog builds and upload the result as an artifact, without committing.

A file that differs only in `generated_at` is not committed.

A separate `verify` job then checks the generated `payloads.json` with Payload Manager's own code. `tools/pldmgr-verify/verify.mjs` builds Payload Manager's unmodified source handling (pinned to a release, `PLDMGR_REF`) together with a small command-line wrapper (`harness.c`). It then adds the file as a source over HTTP, compares the list its web UI receives field by field, and installs every payload, which downloads it, verifies its checksum and writes it to disk. It also flags two payloads that would install into the same folder. The job is informational: a failure shows as a warning, but never fails the run or blocks the deploy. To run it locally (needs `git`, `gcc`, `python3` and the libcurl headers, e.g. `libcurl4-openssl-dev`):

```sh
node tools/pldmgr-verify/verify.mjs payloads.json
```
