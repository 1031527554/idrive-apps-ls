# Maintaining this repository

This is a **personal fork** of
[robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps),
maintained for one owner's own use. It is not intended for a pull request
against upstream.

- `origin` — this repository, `1031527554/idrive-apps-ls` (public).
- `upstream` — the original project. Read-only for us: an occasional source
  of updates, never a push target.

## What this fork adds

| Feature | Where | Released as |
|---|---|---|
| **Show on offers Off** — the projection's switch: the stock map is back at once, the patch stays applied, no head-unit restart | `apps/robertn_waze_cluster/src/waze_cluster_control.js` (`SHOWN_ON`, `shownOnOf()`, `showOn()`), `src/robertn_waze_cluster.js` (drop-down item), `package/rhmiData/uiDescriptions/ID7/uiDescription.json` (`wocShowOn` rows) | 0.6.5 |
| **Map layout** — `Central` / `Full width` / `Full screen` for the cluster: the app picks where the map is drawn and how large, at once, and the choice holds over a restart | App: `waze_cluster_control.js` (`LAYOUTS`, `layout()`, `setLayout()`), `robertn_waze_cluster.js`, `uiDescription.json` (`wocLayout` rows), `locales/*.json`; tool: `native/waze-on-cluster/src/{main,map_feeds,map_feed,map_state}.cpp` (config key `layout`, control command `{"cmd":"layout","value":…}`, status field `layout`); daemon: `patch/patchd.js` (`LAYOUTS`, `saveLayout()`) | 0.9.6 / 0.6.6 |

`Off` was not in upstream 0.6.4 when this was written: upstream's `SHOWN_ON`
still had three values, and stopping the projection meant `Remove patch`
(reverting carplay's binary patch, which waits for a restart). The switch
uses what the tools already did — `{"cmd":"cluster","on":"0"}` on
`/dev/shm/waze-on-cluster/ctl.sock` makes the render drop its layer and lets
the KOMBI show its own content again (`native/waze-on-cluster/src/main.cpp`,
`map_feeds.cpp`), and `patchd` saves it in `map.state.conf`, so `Off` holds
over a restart.

**Map layout.** The cluster's map is drawn either in the native central-map
slot (`map`, 1088x480, under the gauges — upstream's only option) or across
the whole panel (`panel`, 1920x720, over the gauges). `map_rect` stretches the
decoded 1088x480 picture into a rectangle of that target (waze-on-cluster
0.7.10, PR #42), so the three forms are:

| `layout` | target | `map_rect` | What it looks like |
|---|---|---|---|
| `central` | `map` | — | upstream's default: the map in the central area |
| `wide` | `panel` | `0,0,1632,720` | full width, an exact 1.5x enlargement (no distortion), the right 288 px left for the speedometer |
| `full` | `panel` | `0,0,1920,720` | the whole panel, stretched 17.6 % sideways |

The enlargement happens in the display, not on the head unit: the phone still
renders 1088x480 and the upload cost is unchanged. The panel has a scene id of
its own since cluster-render 0.5.0, so a layout and the HUD show at once
(upstream's `162c28e`); before that, `wide` and `full` dropped the HUD's feed,
and this fork still carries that older ordering in the tool's history only.

`layout` is a word, not a number, so it is **not** one of patchd's `MAP_KEYS`
(whose values are numbers and whose keys the driver profiles copy): `saveLayout`
writes it into `map.state.conf` on its own, and a profile's settings written
there only replace the keys it names, so the form stays.

## Releasing

Versions are assigned by the release, not by hand (`release/release.js
plan()`, release/README.md): a component changed since its
`<id>@<version>` tag gets the next version, and the CHANGELOG's
`## Unreleased` lines move under the new heading.

1. Write the change, and its line under `## Unreleased` in
   `apps/robertn_waze_cluster/package/CHANGELOG.md`.
2. Run the app's tests (Linux or WSL: `test_page`, `test_control`,
   `test_profiles`, `test_i18n`; `node release/test/release_test.js`).
   GitHub does not run push-triggered workflows in a fork, so `test.yml`
   also has `workflow_dispatch`: Actions → **Test** → Run workflow runs
   every test, the head-unit builds and the reproducibility check.
3. `git push origin main`.
4. GitHub → Actions → **Release** → Run workflow, `components` empty,
   `dry_run` off. It stamps the version, commits `release: …` to `main`,
   and publishes the artifacts plus the `catalog` release the Store reads.
5. In the car's Store, refresh the source `1031527554/idrive-apps-ls` and
   update.

A version number that was never published is reused as the tree's own
version on the first release (this is why the very first release here went
out as 0.6.4 before the switch got its own 0.6.5).

### The tag stamp compares must be on origin, not just local

`plan()` decides per component by looking up `<id>@<version>` (the tree's own
version) **in the repository the release runs on**. After merging upstream
that version is usually the one upstream just released, so the lookup finds
nothing unless the tag was pushed here — and the component is then taken for
one never released, publishing **this fork's bytes under upstream's version
number**.

Seen on 2026-11-12: the merge brought `waze-on-cluster 0.9.12`, the tag was
fetched locally only, and the release published 0.9.12 with the fork's layout
in it; the release had to be deleted and redone as 0.9.13 once the tag was on
origin.

So, for every component whose tree differs from upstream's tag for that
version, push that tag before releasing. The workspace's
`发布前-标签检查.ps1` does exactly this check (and, with `-Push`, pushes what
is missing); it also says when *not* to push: a component whose tree equals
the tag should be published as "not released yet" under that version, which
is how the fork's catalog gets upstream's own builds.

## Taking an upstream change

```sh
git fetch origin --tags          # our own release tags: the version plan reads them
git fetch upstream --no-tags     # upstream code; --no-tags keeps our tags
git log --oneline HEAD..upstream/main
git merge upstream/main          # or: git cherry-pick <sha> for one change only
```

`CHANGELOG.md` is `merge=union` (`.gitattributes`), so two sets of
`## Unreleased` lines merge without a conflict. Expect conflicts only where
upstream edits the same lines this fork did — the three places in the table
above. The version files (`mgu-app.json`, `package/package.json`,
`npm-shrinkwrap.json`, `rhmiData/application.json`) may conflict too: take
either side, the release rewrites them.

Two tag sets share names (for example `robertn_waze_cluster@0.6.4` is ours at
`4cad53f` and upstream's at `05e38ec`), so always fetch upstream with
`--no-tags`; and if our tags ever get clobbered, `git fetch origin --tags
--force` restores them.
