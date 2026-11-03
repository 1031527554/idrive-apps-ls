# aa-on-cluster

Android Auto's **instrument-cluster view** of Google Maps in the cluster's
central map area, on an iDrive 7 (MGU) whose aapd keeps the cluster screen
off. A Store tool: install and remove it from the Store; it changes nothing
until the next head-unit start and puts stock back by itself if aapd ever
crashes.

## What the phone sends, and what was wrong

aapd already declares the cluster to the phone as Android Auto's **CLUSTER**
display (Cinemo `VIDEO_DISPLAY_TYPE` 1; only type 2, AUXILIARY, carries a
navigation/turn-card sub-type), so Google Maps renders its dedicated cluster
view. Three things kept it from showing well:

1. aapd's coding gate keeps the cluster screen off on this cluster variant
   (KOMBI4 high, KombiVariant 2), and aapd never requests the stream.
2. aapd has no screen size for KombiVariant 2 (0 -> 12.3", 1 -> 10.25", any
   other -> none), so it ignores `/etc/aapd.conf`'s `KOMBI_DISPLAY` block and
   uses built-in defaults: an 800x480 stream whose UI is its top 800x300,
   black below (measured on the car). Squeezed whole into the 1088x480 map
   slot, that was half a map.
   `patch/aapd_patch.js` (PATCH.md) does these first two: the gate, the
   self-start and the screen size (KombiVariant 2 reads the 12.3" entry).
3. The geometry. The 12.3" entry asks for 1920x1080 laid out for a cluster
   that draws the stream across its panel. `patch/aapd_conf.js` asks instead
   for 1280x720 with the UI the top 1280x564, the map slot's 2.27:1 (margins
   0x156 at 0,0), at the owner's density (below, 180 dpi unless chosen),
   and the CarPlay patch's proven safe area for the slot at that scale (592x432 at
   336,84), so the phone keeps its turn card where the gauges leave the slot
   clear. waze-on-cluster's `src_crop` (0.7.10) takes the 1280x564 and scales
   it 0.85x into the whole slot: the crop drops only the black margin, and
   scaling down from more pixels than the slot has keeps text sharp.
   (Measured on the car: the phone draws rows 0..561 of the 720, black
   below.)

How aapd.conf's numbers reach the phone (decompiled from aapd's cluster
setup): the resolution follows `CODEC_HEIGHT` (480 -> 800x480, 720 ->
1280x720, 1080 -> 1920x1080); margins left/top =
`OFFSET_LEFT/TOP_TARGET_VIEWPORT`, right/bottom =
`HORIZONTAL/VERTICAL_MARGIN_SIZE` minus those; content insets = the
`DIMENSIONS` entry's `SA_*PIXELS` rect less the offset.

Earlier releases edited aapd.conf for a 1920x1080 stream (0.1.0, which also
left KombiVariant 2 without a screen size), an 800x480 one with its UI the
top 800x352 (0.2.0, scaled up 1.36x and softer) and this geometry at one
fixed density (0.3.x); this one recognises all of them and upgrades them in
place (and removes them like its own).

## Density: how much map

Android Auto has no zoom the car can set: Google Maps picks it from speed and
the next turn, in physical units (dp, 1/160 inch). The density the phone is
told sets how big the 1280-pixel picture is in those units, so a lower one
shows more map, with the turn card and text smaller by the same amount. The
picture's sharpness is the same at all three.

Any density from **150 to 400 dpi in steps of 10** (180 unless chosen); 150-300
suits the cluster, and up to 400 is for trying the map on the HUD (larger text
on a small display).

| density | the picture to the phone | on the car (2026-11-02) |
|---|---|---|
| 240 dpi | 850 dp wide (about the slot's own 235) | largest text; a two-line turn card for a long street name |
| 200 dpi | 1,020 dp, about 15% more map | in between; the trip bar with the card hidden |
| 180 dpi (default) | 1,140 dp, about 30% more map | the smallest card, often one line |

```sh
node /var/opt/aa-on-cluster/current/aoc.js density        # the current one
node /var/opt/aa-on-cluster/current/aoc.js density 200    # choose; then restart the head unit
```

0.3.0 and 0.4.0 offered 235; it is no longer a choice, but an aapd.conf at
235 is still recognised and restored, and a saved 235 reads as 240.

The choice is kept in `/var/opt/aa-on-cluster/density` across updates and
used by every activation; removing the tool drops it.

## Turn card (experimental)

Google Maps pins its turn card to the top of the safe area it is given; this
build of aapd has no setting for Android Auto's own flag to hide it. With
`card hidden` the phone gets the whole 1280x720 as its UI with the safe area
starting at the top (592x672 at 336,0), so the card is drawn in the top rows,
and waze-on-cluster's crop takes the rows under them. The card grows with
the density (its bottom edge is about 0.62 x dpi rows down), so the cut does
too: 156 rows up to 200 dpi (`src_crop = 1280x720:0,156,1280,564`), then
0.62 x dpi + 10 rows, rounded up to even, and the crop narrows to keep the
slot's 1088:480 shape (240 dpi: `4,160,1270,560`; 300: `46,196,1188,524`; 400:
`116,258,1048,462`). A tall card (lane guidance, a "then" line) can still show
its lower edge.

```sh
node /var/opt/aa-on-cluster/current/aoc.js card          # the current one
node /var/opt/aa-on-cluster/current/aoc.js card hidden   # or shown; then restart the head unit
```

Kept in `/var/opt/aa-on-cluster/card` like the density.

## The control socket

`aa-on-cluster-ctl.service` (root, from boot, `aoc.js serve`) listens on
`/dev/shm/aa-on-cluster/ctl.sock`, `root:tm_oap_app` mode 0660, the pattern
of waze-on-cluster's patchd: every OAP app process has `tm_oap_app`. One
JSON request per connection, one reply line:

| Request | Reply |
|---|---|
| `{"cmd":"status"}` | `{"ok":true,"state":"active","density":180,"card":"shown","running":{"density":180,"card":"shown"},"pending":false,"choices":[150,160,...,400],"range":{"min":150,"max":400,"step":10},"cards":["shown","hidden"]}` |
| `{"cmd":"density","value":200}` | the status after the change |
| `{"cmd":"card","value":"hidden"}` | the status after the change |
| `{"cmd":"restart"}` | `{"ok":true,"restarting":true}`, then the head unit's normal restart; refused unless a change is pending, and within the Store's limits |

`state`: `active`, `inactive` (stock: removed or restored by recovery) or
`unknown` (a firmware this tool doesn't know; changes refused). The restart
is the Store's: `/usr/bin/nsm_control --requestRestart 7 --normal`, the Node
State Manager's normal restart (the HMI's own), so BMW's services get the
normal shutdown; never `systemctl reboot`, which stops them by their
`KillSignal` (SIGABRT for many). Same limits as the Store: not in the first
240 s after a start, one per 10 min, three an hour (kept in
`/var/opt/aa-on-cluster/reboots.json`); `nsm_control`'s `[Error. ...]` or a
unit still up after 3 min shows in status as `restartError`. `running` is
what aapd started with this boot (recorded by the boot check before aapd
starts, in `/dev/shm/aa-on-cluster/running`); `pending` is a choice that
differs from it. A bad request gets `{"ok":false,"error":"..."}` and changes
nothing. The daemon edits files only (the same code as the shell commands);
it never stops or restarts aapd.

## Pieces

| | |
|---|---|
| `patch/aapd_patch.js` | the four aapd sites (gate, selfstart call, selfstart guard, screen size), SHA-pinned, backup `/usr/bin/aapd.aa-orig` |
| `patch/aapd_conf.js` | the geometry edit, numbers replaced in place, SHA-pinned, backup `/etc/aapd.conf.aoc-orig` |
| `patch/aoc_files.js` | both edits in one remount window, the running aapd kept linked, `src_crop` in waze-on-cluster's local conf between marker lines |
| `patch/aoc.js` | the Store's `activate` / `deactivate` hooks, `status`, `density`, `card`, and `serve` (the control socket) |
| `patch/recovery.js` | `aa-on-cluster-boot.service` (before aapd) and `aa-on-cluster-recovery.service` (watches aapd) |

The map itself is drawn by waze-on-cluster's capture (the same AVB stream 15
CarPlay's cluster stream uses) through cluster-render; aa-on-cluster requires
waze-on-cluster 0.7.10. Its CarPlay patch stays off unless its own app turns
it on.

## Safety

- Activation writes files only: aapd, aapd.conf and waze-on-cluster pick
  them up at the next head-unit start (the Store shows the tool
  restart-pending). Nothing is stopped or restarted: an aapd or CarPlay death
  that recmgr does not restart power-cycles the head unit.
- The install adds `aapd` to recmgr's restart lists and to the crash
  handler's whitelist (`crashNames`, read at boot), so an aapd that exits or
  dumps core is restarted instead of rebooting the head unit.
- Recovery: aapd changing PID twice before running 120 s (not while the
  system stops), or two boots in a row in which aapd never ran 20 s,
  restores stock aapd and aapd.conf from the verified backups (aapd's next
  start is stock). It never kills, restarts or reboots.
  `node /var/opt/aa-on-cluster/current/aoc.js status` shows the record;
  reinstall from the Store to try again.
- Files that are not the known originals (a firmware update) are refused
  before anything is written, and never restored over.
- `src_crop` is a setting only waze-on-cluster 0.7.10 and newer know; an older
  one refuses to start on a local conf that sets it. Activation refuses
  without 0.7.10 installed, and each boot takes this tool's `src_crop` out
  again before waze-on-cluster starts if an older one is installed.
- Remove in the Store restores both files and the local conf, then asks for a
  head-unit start.

## Build and install

From an idrive-apps checkout:

```sh
node release/release.js build waze-on-cluster aa-on-cluster   # kits and catalog.json into release/out/
```

(waze-on-cluster's binary is built in Docker). Install the kits over the ENET
cable with mgu-store's deploy tool, one run each, waze-on-cluster first (a run
installs tools in name order, and aa-on-cluster refuses to activate without
waze-on-cluster 0.7.10 in place):

```sh
deploy/hu install --yes --artifact release/out/waze-on-cluster@0.7.10.tgz
deploy/hu install --yes --artifact release/out/aa-on-cluster@0.7.0.tgz
```

or install **Android Auto on cluster** from the Store once it is published (it
brings waze-on-cluster 0.7.10). Then restart the head unit.

## On the car, first time

1. After the restart, connect the phone, start navigation in Google Maps, set
   the cluster to its map view.
2. `/var/opt/waze-on-cluster/log/waze-on-cluster.log` has
   `decoder: sequence 1280x720, map from its 1280x564 at 0,0, to 1088x480`.
3. The map fills the slot. If the phone draws a different height than it
   was asked for (black at the bottom of the map, or the map cut), set the
   owner's own crop in `/var/opt/waze-on-cluster/waze-on-cluster.local.conf`,
   which wins over this tool's: `src_crop = 1280x720:0,0,1280,<height>`.
   The phone without this tool's geometry sends 800x480 and draws 800x300.

Known limits: Google Maps' cluster view draws its own turn card; Android
Auto's flag that hides it (`hidden_ui_elements`) has no Cinemo setting on
this build. The media widget over the right gauge is the cluster's own, not
Android Auto's.

The HUD (tried on one car): waze-on-cluster's `hud` target shows
Android Auto's map on the HUD (`waze-on-cluster -c <conf> run hud`, back with
`run map`; no restart). The map is on one target at a time, so the cluster
has none meanwhile. It is the same picture as the cluster's, the wide
cluster view at the chosen density, fitted into a 453x200 box in the middle
of the HUD's 800x480: it shows, but is too small to use. A usable HUD needs
its own geometry (larger text, the part around the car), which this tool
does not have yet; the phone sends one picture, so the cluster and the HUD
cannot each get their own at the same time.

## Test

```sh
AOC_FIRMWARE=<folder with the unit's usr/bin/aapd and etc/aapd.conf> node test/aoc_test.js
```

Install hooks, idempotence, the running-binary link, refusals, boot and crash
recovery, on copies of the unit's files with / , /proc and systemctl faked.
Firmware files never go in this repository.

---

Copyright (C) 2026 mlurker@gmail.com. Licensed GPL-3.0-or-later.
