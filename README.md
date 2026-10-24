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

To leave an entry out temporarily, for example while it's broken upstream, set `enabled: false` on it in `catalog.yaml`. It isn't looked up or downloaded, and Payload Manager no longer offers it. The site still lists it, in a separate "Inactive" section at the bottom, with an **inactive** badge and its upstream link but no download. That entry lives in a separate `inactive` list in `payloads.json`, without a file or URL, so Payload Manager's parser skips it. An enabled entry can't `require` a disabled one.

## Archives

Some projects ship their payloads inside a `.zip`. Payload Manager can only download and run a single `.elf`/`.bin`, so:

- **One file from an archive:** set `source.extract` to the file's name. The generator downloads the archive, checks it against GitHub's digest, extracts that file and checks it against the archive's own `SHA256SUMS` if there is one. It then writes the file to `files/` (git-ignored). The workflow publishes `files/` with the site, and the entry's URL points to `<base_url>files/<name>`, so `base_url` must be set at the top of the catalog. Example: the five `fan_target` temperature builds.
- **A whole archive:** an entry with `kind: download` (and e.g. `extension: .zip`) is a site-only download, such as an app you install by hand. It's checksummed like any other entry and listed in an "Apps" section on the site, linking to the upstream file. It sits in a separate `downloads` list in `payloads.json`, with `file`/`download` instead of `filename`/`url`, so Payload Manager's parser skips it. Example: PS5X360's `PPSA50011.zip`.

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

## What the output contains

`payloads.json` follows Payload Manager's custom repository format (version 0.6 and later). For each payload the generator writes:

- **`id`:** the catalog id. Payload Manager installs each payload into a slot named after its id, and favorites and autoload follow that slot across updates, so an id should never change once published. Ids use only `a-z`, `0-9`, `.`, `_` and `-`. External entries get their catalog's name as a prefix (e.g. `orbit-store.orbit-store-beta`), so they can't clash with ours.
- **`last_update`:** the release date, which Payload Manager uses to break ties between equal versions.
- **`source`:** the upstream project page.
- **`checksum`:** always present. Payload Manager verifies every download against it.

Values must fit Payload Manager's field sizes (for example, 127 bytes for names and 1,023 for URLs). Longer values would make it reject the entry, so the generator fails instead.

The site-only `inactive` and `downloads` lists come after `payloads`. Payload Manager still scans everything from `"payloads"` to the end of the file, but it only accepts objects that have `name`, `filename` and `url`. So inactive entries have no file or URL, and downloads use `file`/`download` instead.

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

A separate `verify` job then checks the generated `payloads.json` with Payload Manager's own code. `tools/pldmgr-verify/verify.mjs` builds Payload Manager's unmodified source handling (pinned to a release, `PLDMGR_REF`) together with a small command-line wrapper (`harness.c`). It then adds the file as a source over HTTP, compares the list its web UI receives field by field, and installs every payload by `id` into its own slot, which downloads it, verifies its checksum and writes it to disk with its metadata. It also flags two payloads that would install into the same slot. The job is informational: a failure shows as a warning, but never fails the run or blocks the deploy. To run it locally (needs `git`, `gcc`, `python3` and the libcurl headers, e.g. `libcurl4-openssl-dev`):

```sh
node tools/pldmgr-verify/verify.mjs payloads.json
```
