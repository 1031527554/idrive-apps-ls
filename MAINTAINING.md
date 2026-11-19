# Maintaining this repository

This is a **personal fork** of
[robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps),
maintained for one owner's own use. It is not intended for a pull request
against upstream.

- `origin` — this repository, `1031527554/idrive-apps-ls` (public).
- `upstream` — the original project. Read-only for us: an occasional source
  of updates, never a push target.

## What this fork adds

**Nothing to the components themselves.** Upstream's tree is what ships from
here; the fork exists to publish those tools from this repository's own Store
source and to keep one owner's car up to date. What it adds:

| Addition | Where | Why |
|---|---|---|
| `mgu-repo.json` | repository root | lets the Store install from this repository's tree (a branch source), beside the `catalog` release |
| `workflow_dispatch` on the Test workflow | `.github/workflows/test.yml` | push-triggered workflows do not run in a fork, so the suite is started by hand |
| this file | `MAINTAINING.md` | the fork's own conventions |

### The two features this fork used to carry, and why neither is here now

- **`Off` on Show on** (released as 0.6.5): stopping the projection without a
  restart. Upstream implemented the same idea (`48e5790`, PR #112) and this
  fork dropped its copy when it merged that.
- **Map layout** (`Central`, `Full width`, `Full screen`; released as 0.9.6 and
  0.6.6): the app chose the cluster map's target and rectangle, which needed
  the tool's `target` setting, its `map_rect` and the control socket's `start`
  command. Upstream removed that plumbing in PR #214 (2026-11-19, "the cluster
  map always on its map slot": no settings file of another tool may change how
  the map shows). The fork dropped the feature rather than keep a divergence
  that every later merge would have to carry; `Central` is what upstream does
  now, on every car.

  A full-width layout with a live map inside it is upstream's **scene
  hosting**: a scene file that hosts another target's content (`layers 1`, the
  host's rect, `hosted_vpp_scale`). It needs a client that draws the layout —
  cluster-render supports it, no such client exists yet.

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
fetched locally only, and the release published 0.9.12 with this fork's own
changes in it; the release had to be deleted and redone as 0.9.13 once the tag
was on origin.

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
