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

`Off` was not in upstream 0.6.4 when this was written: upstream's `SHOWN_ON`
still had three values, and stopping the projection meant `Remove patch`
(reverting carplay's binary patch, which waits for a restart). The switch
uses what the tools already did — `{"cmd":"cluster","on":"0"}` on
`/dev/shm/waze-on-cluster/ctl.sock` makes the render drop its layer and lets
the KOMBI show its own content again (`native/waze-on-cluster/src/main.cpp`,
`map_feeds.cpp`), and `patchd` saves it in `map.state.conf`, so `Off` holds
over a restart.

## Releasing

Versions are assigned by the release, not by hand (`release/release.js
plan()`, release/README.md): a component changed since its
`<id>@<version>` tag gets the next version, and the CHANGELOG's
`## Unreleased` lines move under the new heading.

1. Write the change, and its line under `## Unreleased` in
   `apps/robertn_waze_cluster/package/CHANGELOG.md`.
2. Run the app's tests (Linux or WSL: `test_page`, `test_control`,
   `test_profiles`, `test_i18n`; `node release/test/release_test.js`).
3. `git push origin main`.
4. GitHub → Actions → **Release** → Run workflow, `components` empty,
   `dry_run` off. It stamps the version, commits `release: …` to `main`,
   and publishes the artifacts plus the `catalog` release the Store reads.
5. In the car's Store, refresh the source `1031527554/idrive-apps-ls` and
   update.

A version number that was never published is reused as the tree's own
version on the first release (this is why the very first release here went
out as 0.6.4 before the switch got its own 0.6.5).

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
