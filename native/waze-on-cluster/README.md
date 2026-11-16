# waze-on-cluster

The part of [Maps on cluster](../../apps/robertn_waze_cluster) that runs in
the background: it puts the CarPlay or Android Auto map on the instrument
cluster of a BMW with iDrive 7.

You don't install or use it on its own. The Store installs it with the
**Maps on cluster** app, and you control it from that app. Settings, what to
do if the map doesn't show, and how to send logs:
[Maps on cluster](../../apps/robertn_waze_cluster/README.md).

## For developers

Shows the CarPlay instrument-cluster map (Waze, Apple Maps or Google Maps),
or Android Auto's (Google Maps), on the instrument cluster of a BMW with an
iDrive 7 head unit (MGU). It runs as root tools on the head unit and is
driven from the HMI by the companion app
[robertn_waze_cluster](../../apps/robertn_waze_cluster).

Both send the cluster map only as H.264 video, with no map data, so this is
a video pipeline:

1. **Ungate the second display.** A reversible patch to
   `/usr/bin/carplay` makes `KI_KOMBI_VARIANT` 7 resolve to a supported
   cluster variant, makes CarPlay start the cluster stream itself, and
   advertises the size the map is shown at ([patch/PATCH.md](patch/PATCH.md)).
   Another to `/usr/bin/aapd` and `/etc/aapd.conf` does the same for Android
   Auto (PATCH.md "Android Auto"). Each is applied only where it is
   supported, and each on its own.
2. **Capture.** The phone sends the stream as RTP to the stock media-bus sink,
   AVB stream `media_transport.avb_streaming.15`; the render joins it as an
   extra receiver. It also listens on a local UDP port and a FIFO, which
   other sink patches can point at.
3. **Decode.** One decode thread depacketises RTP to H.264 Annex B
   (`src/rtp_h264.*`) and decodes it with the unit's Intel Media SDK / VAAPI
   on `/dev/dri/renderD128`, through any lost packets.
4. **Draw.** Each frame goes to the shared cluster renderer,
   [cluster-render](../cluster-render), as a video layer (`src/map_feed.*`)
   on its `map` target, and on `hud` when the map is shown there.

### Install and remove

The Store installs it with the app `robertn_waze_cluster`; it requires
`cluster-render` and `mgu-deploy` (`component.json`, `"requires"`).

**Install.** The deploy tool runs `patchd.js activate` as root. On a car
coded `KI_KOMBI_VARIANT` 7 with a proven carplay build (or one CarPlay's
Patch button patched before), it writes the patch and never stops, kills or
restarts CarPlay: the Store shows a restart pending, the app `Status:
Patched after restart`, and one head-unit start runs the patched CarPlay.
It then writes the Android Auto patch the same way on a proven aapd build.
Anywhere else it leaves the binary as it is, and the app's Status says why
(PATCH.md "Install-time activation").

**Remove.** In the Store, remove the app, then the tool (refused while the
app is installed). `patchd.js deactivate` reverts our edits to carplay,
aapd and aapd.conf and drops our backups; the deploy tool then removes this
tool's services and files. The next head-unit start runs the original
CarPlay and aapd.

### Using it

The app's **Patch** and **Remove patch** buttons, for CarPlay and for
Android Auto, apply and revert the patches through the root patch daemon
`patchd`. A change takes effect when CarPlay (or aapd) next starts: `patchd`
restarts it at once only where that cannot restart the head unit (PATCH.md
"Activation"); otherwise the app shows **Restart head unit**.

**Never `systemctl stop` or `restart` carplay or aapd**: CarPlay dumps core
on SIGTERM, which restarts the head unit.

**Boot recovery.** If a patch keeps the head unit restarting, the boot step
restores the original binary before CarPlay (or aapd) starts: after one
failed start for a patch not yet proven on that car, after two for a proven
one. CarPlay comes back without the map, its Status reads `Removed — head
unit kept restarting`, and its Patch button applies the patch again
(PATCH.md "Boot recovery").

To break a loop by hand: keep the phone from connecting (unplug it, or turn
off its Wi-Fi and Bluetooth), then over SSH run
`sh /var/opt/waze-on-cluster/current/woc-patch.sh revert` (CarPlay) or
`... woc-patch.sh aa-revert` (Android Auto) and restart the head unit.

**Android Auto.** **Zoom out** and **Zoom in** change the density the phone
is told (150-400 dpi, 180 by default; lower shows more map with smaller
text), and **Hide phone's turn card** crops Google Maps' turn card off the
top of the map. Each takes effect when aapd next starts.

**When the map shows.** The map comes up in the cluster's central map slot
at the stream's first non-blank picture and stays while the phone's
cluster stream is live. When the stream ends, stays blank for `blank_ms`
(10 s) or freezes for `freeze_ms` (10 s), the slot goes back to the
cluster's own content until the next picture. The render runs from boot and
decodes whether or not the map is shown, since the phone sends a keyframe
only when its stream starts: a render that missed the start shows nothing
until the phone reconnects.

**BMW's turn box.** While the map shows, BMW's CarPlay turn-by-turn box on
the cluster is hidden (cluster-render README, "Guide hold"). The app's
**Hide BMW's turn box** checkbox turns that off and on at once.

**Where the map shows.** The app's **Show on** sets the cluster, the HUD,
both or neither (**Off**), at once. On the HUD the frames are scaled on the
head unit to the size shown (**Size**, 30 % to 85 % of the HUD's width, or
Standard, about 57 %), moved by **Position**, the corners rounded and a
night map's background made black, which the HUD shows as nothing. With
both, the HUD gets up to half the upload budget, only what it uses. The
HUD map steps aside while BMW's HUD lists show (never for route guidance),
unless **Keep HUD map over BMW's pop-ups** is ticked. **Own settings for
this driver** gives the driver profile in use its own copy of these
settings.

From a shell, `waze-on-cluster -c <conf> run map|panel` sets the cluster
target until the service restarts and prints the status.

**Inside another app's scene.** An app that shows a scene file on a target
with `layers` 1 can host the map there (cluster-render PROTOCOL.md
"Hosting another target"): the map is then drawn only in the rect it
names, scaled on the head unit to that part of the picture. With
`hosted_vpp_scale = 1` (experimental, off by default) the decoder's VPP
crops and scales that part on the GPU instead, while the HUD map is off;
where VPP cannot, it logs so and the CPU scales it as before
(`waze-on-cluster.conf`).

### Settings

Settings are in `waze-on-cluster.conf` (documented inline). Overrides go in
`/var/opt/waze-on-cluster/waze-on-cluster.local.conf`, which updates keep;
the app's map settings are in `/var/opt/waze-on-cluster/map.state.conf`.

### Map size and upload

cluster-render writes only the 64x64 tiles of a frame that changed. The
upload budget is cluster-render's: set it with `upload_kb_per_s` in
`/var/opt/cluster-render/cluster-render.local.conf` (cluster-render README,
"Upload budget").

The map covers the cluster's central map area, 1088x480 on the 1920x720
panel. The patch advertises exactly that, so `tex_size` must equal it.
`src_crop` takes part of a picture of one size and scales it to `tex_size`
(Android Auto's 1280x720 stream has its map in the top 1280x564).
`map_rect` draws the map stretched into a rect of the current target.
`target_fps` (30) caps the frame rate; `picture_fps` (0: every frame) makes
at most that many pictures a second, which saves CPU when the phone sends
more than the cluster takes (set it to `target_fps` then).

### Logs

For a report, use the app's **Logs** page (Maps on cluster README, "Logs
and reporting a problem"), or run as root on the unit
`sh /var/opt/waze-on-cluster/current/collect-logs.sh [-o <folder>]`: it
writes `woc-logs-<UTC date and time>.tar.gz` into the folder (`/tmp` by
default) and prints its path. The archive holds both tools' logs, the kept
journal, patchd's CarPlay and DLT lines (`patchd-logs.json`), the status
files, the patchers' state and the head unit's restart records.
`incidents.txt` lists the tools' `INCIDENT` lines (each time the map was
lost), the boots and the time of the export, oldest first. Every file is
scrubbed before it goes in: VINs, MAC addresses, IP addresses outside the
car's own networks, Wi-Fi network names, phone and device names, keys and
tokens are replaced by tags (one address keeps one tag within an archive).
The coding image, core dumps and the deploy tool's tokens, credentials and
sources are left out.

- The render's log: `/var/opt/waze-on-cluster/log/waze-on-cluster.log`
  (and `.log.1`), in UTC.
- Its status, once a second: `/run/waze-on-cluster/status.json` (what the
  app shows) and `probe.txt` (the sources, the decoder, losses, timing).
- The journal service keeps in `/var/opt/waze-on-cluster/journal/` (10
  files of 384 KiB, across restarts) the tools' journal, the lines of
  carplay, recmgr and the crash handler, systemd's lines about any unit
  that starts, stops, is killed or fails, and the kernel's, without the
  high-volume lines that explain nothing (the firewall's blocked packets,
  Wi-Fi scans, audit records) and with a short summary of each boot's
  kernel log. Every 30 s it adds a load line: the load averages,
  MemAvailable, the processes in D state and the 5 processes that used the
  most CPU.
- **Save logs** keeps at most 5 archives in `/var/opt/waze-on-cluster/saved`.
  The Logs page serves them to a phone on the car's Wi-Fi hotspot, at the
  address it shows, while the page is open and for 15 minutes after a save.

### The patches

`patch/carplay_patch.js` and `patch/aapd_patch.js` (Node 8, no
dependencies) find their edit sites in the build, check them, take a
verified full backup, and write by atomic rename. The install patches only
a proven build; another build whose sites are all found is patched once a
Patch button (or `apply --unproven`) asks. Edits, sites and proven builds:
[patch/PATCH.md](patch/PATCH.md).

`woc-patch.sh` (in `/var/opt/waze-on-cluster/current/`) is the shell path,
for experiments and for undoing the patches without the app:

| Command | |
|---|---|
| `status`, `aa-status` | what is on disk |
| `probe` | where the edit sites are in a carplay binary and whether it is patchable, without writing |
| `verify` | whether carplay's patch is complete |
| `revert [--force]` | restores the original carplay; `--force` over another build (a firmware update) |
| `aa-revert [--force]` | restores the original aapd and aapd.conf |
| `apply high\|mid` | applies the patch: `--avb` (the app's sink), no flag (`udp://127.0.0.1:20557`), `--capture` (FIFO) or `--sink <url>`, plus `--res WxH\|stock`, `--safe WxH+X+Y\|full` and `--unproven` |

It remounts `/` read-write only for the write.

### Building and testing

```sh
make test                         # host tests
make test-x86                     # the C++ tests with the unit's toolchain in Docker (SSE2 paths)
make target                       # build/target/waze-on-cluster in Docker, imports checked
make test-firmware ROOTFS=<dir>   # DLT capture against the unit's own dlt-daemon in Docker
```

`CR` names cluster-render's tree, `../cluster-render` by default; it also
gives the log, the config, the unit's ABI tools and the build image. The
target builds in Ubuntu 18.04 (gcc 7.5, glibc 2.27) against link-only stubs
of the unit's libmfx, libva, libva-drm and IAS AVB bridge
(`abi/*.symbols`).

The repository carries no BMW binary. The patch tests take copies of the
unit's files: `CARPLAY_BIN` (carplay 22.28.3), `CARPLAY_BINS` (other
carplay builds, separated by `:`), `AAPD_BIN` (aapd 22.39.3),
`AAPD_CONF` and `AAPD_BINS` (other aapd builds, separated by `:`); tests
that need one are skipped without it. `test-firmware` takes `ROOTFS`, an
extracted root file system of the unit.

### License

GPL-3.0-or-later (`LICENSE`). `abi/include/mfx/` is a subset of the Intel
Media SDK headers under the MIT license (`abi/include/mfx/LICENSE`).
Third-party files keep their own licenses.
