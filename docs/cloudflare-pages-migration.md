# Cloudflare Pages migration preparation

Prepared 17 September 2026. This branch prepares deployment; it does not change the
live GitHub Pages site or create a Cloudflare project.

## Deployment approach

Keep the pinned Emscripten/Rust build in GitHub Actions. The manual
`cloudflare-pages.yml` workflow downloads the existing `github-pages` artifact
from a successful **push to wasm-port**, unpacks `artifact.tar`, validates the
entire directory, then uploads that same bundle. Cloudflare does not rebuild the
game. The default target is a preview; production is an explicit selection.

This follows [Cloudflare's Direct Upload CI workflow](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).
Use a **Direct Upload Pages project**, with production branch `wasm-port`.
Cloudflare documents that switching this project to its Git integration later
requires a new project; GitHub Actions can still automate Direct Upload releases.
See [Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/).

No Pages Functions, Workers, R2 or game-server process is required. The game runs
on the player's device; disc images and HD packs remain user-selected local files.
A hosting move does not move shader compilation to the server or guarantee higher FPS.

## Prepared changes

- `.github/workflows/cloudflare-pages.yml`: manual deployment of an existing build,
  with successful-run/provenance checks, preview/production separation and a check
  that the destination's production branch really is `wasm-port`.
- `web/cloudflare_bundle.mjs`: inspect **every** upload file, including optional
  nested assets, for the 25 MiB/file and 20,000-file limits. Reject upload symlinks.
  The existing `web/check_build.mjs --cloudflare` now calls it.
- `web/_headers` already applies COOP `same-origin`, COEP `require-corp`, CORP
  `same-origin` and `nosniff` to all paths. No new header change is necessary.
  [Pages applies `_headers` to static responses](https://developers.cloudflare.com/pages/configuration/headers/);
  this would need revisiting if a Function starts serving these assets.
- The GitHub isolation service worker remains available. A fresh Cloudflare page
  with correct response headers already has `crossOriginIsolated`, so the worker
  registration is skipped. Asset paths are relative and work at the origin root.

The last pre-release live bundle measured 21,022,205 bytes for Wasm and 7,986,898
bytes for data. Revalidate the selected release rather than relying on these
older sizes. [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
apply per file, not to the combined bundle. The new validator reports the largest
files; watch the Wasm's remaining headroom as features are added.

## Account setup needed before the first preview

1. Select the Cloudflare account and an available Pages project name. Decide on a
   stable public hostname before inviting users, to avoid another storage move.
   A custom domain is optional; a `pages.dev` hostname can be used first.
2. Create a Direct Upload project whose production branch is `wasm-port`.
3. In GitHub, create environments `cloudflare-preview` and `cloudflare-production`.
   Set these in each environment:

   | Kind | Name | Value |
   | --- | --- | --- |
   | Variable | `CLOUDFLARE_ACCOUNT_ID` | Account ID |
   | Variable | `CLOUDFLARE_PAGES_PROJECT` | Exact project name |
   | Secret | `CLOUDFLARE_API_TOKEN` | Token with Account → Cloudflare Pages → Edit, restricted to that account |

   Enter the token directly in GitHub's secret settings; never commit it or paste
   it into project notes. Optional production-environment reviewers can be set
   according to the repository owner's normal release preferences.
4. Merge/register the manual workflow on the repository's default branch before
   dispatching it. Preparation remains on a separate branch until that setup.
5. Run **Publish existing build to Cloudflare Pages**, target `preview`, with the
   successful production build run ID. The async release candidate is run
   `35241380680`, commit `60b0074859ac5650b8914803ad1a32f5f42fdcf3`; use it only after
   its conclusion is success and while its `github-pages` artifact is unexpired.
   The workflow refuses PR runs, other workflows, unsuccessful runs and expired
   artifacts. If it has expired, use a newer successful production build.
6. Validate the returned URL. Publish the same run ID with target `production`
   after the browser checks below. This does not rebuild or alter GitHub Pages.

Wrangler is constrained to major 4, matching the current Pages CLI. Before enabling
an ongoing release schedule, choose an exact approved version if reproducibility
across future Wrangler updates is required. No account/token/project is configured
by this preparation, and the authenticated upload itself has not been exercised.

## Browser acceptance checks

Start from a fresh tab on the final origin, with no old service worker installed.
Confirm response headers on the HTML, JS and Wasm, `application/wasm` for the Wasm,
`crossOriginIsolated === true`, and availability of `SharedArrayBuffer` and WebGPU.
Then test local USA `.ciso` startup, the showcase, a ZIP HD pack, save import/export,
settings persistence, async shaders ON/OFF, mouse capture, resizing and tab resume.
Repeat after reload and inspect the console for worker/isolation failures.

Check every linked JS file comes from the same deployment. Avoid adding long-lived
`immutable` cache rules to unversioned `index.js`, `index.wasm` or `index.data`.
Compare showcase runs at identical resolution, HD-pack and async settings; inspect
skipped draw counts alongside FPS. Keep the current GitHub site working during the
preview and initial production validation.

## Player data and cutover

`vibepfrog.github.io`, the preview hostname, `pages.dev` and a custom hostname are
separate browser storage origins. Campaign saves, settings and learned shader
recipes do not move automatically between them. Do not clear the old site's data.

Before moving a campaign, export the save from the GitHub site and import that
file on the final production hostname. Keep the exported backup. Reapply settings
as needed; the shader cache can rebuild on the new origin. The showcase exports
shader recipes, but this branch does not add a cross-origin recipe importer.
ROM and texture-pack files must be selected again; neither is uploaded to Pages.

Choose the stable hostname before announcing the migration. Keep the old URL
accessible until save transfer is verified. There is no forced redirect in this
preparation. Rollback is either the previous Cloudflare deployment or directing
players back to GitHub Pages; saves created on the new origin must be exported
and imported back before continuing there.

## Validation recorded for this preparation

The bundle validator tests cover nested oversized files, the exact 25 MiB boundary,
file-count limits and symlink cycles. Workflow YAML and inline JavaScript parse.
The workflow is manual-only. Cloudflare API authentication, actual upload, custom
domain/DNS and final-origin browser behavior require the account setup above.
