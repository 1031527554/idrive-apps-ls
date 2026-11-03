# The aapd patch, byte for byte

`aapd_patch.js` makes four reversible edits to `/usr/bin/aapd` (the Android
Auto Projected Daemon) that ungate the instrument-cluster ("alternate" /
second) video screen, make aapd request it itself and give that cluster its
screen size, so Google Maps renders its cluster map in the geometry
`/etc/aapd.conf` describes. It is the Android Auto analog of
`../../waze-on-cluster/patch/carplay_patch.js`.

## The edits

| Edit | What it does | Where |
|---|---|---|
| gate | `KombiVariant <= 1` → `<= 2` in `secondVideoEnabled()` | 1 B at file `0x998c3` (`01`→`02`) |
| selfstart/call | `onNewNavigationStatus()`'s shared tail: `setNaviStreamStatus` → `requestStream` | 5 B at file `0x1d43eb` (`e800f8ffff`→`e840fbffff`) |
| selfstart/guard | `requestStream()`'s entry check on a readiness field that never gets set: `je` → unconditional `jmp` (NOP-padded) | 6 B at file `0x1d3f5d` (`0f848d000000`→`e98e00000090`) |
| size | KombiVariant → screen size: 2 reads 12.3 like 0 (others unchanged) | 16 B at file `0x15b440` (`660fefc0ebe1662e0f1f840000000000`→`83f802740b660fefc0ebdc0f1f440000`) |

### Why gate
`aapd`'s `Application::secondVideoEnabled()` returns
`featureFlag && (KombiVariant <= 1)`, compiled as
`cmp dword [rbx+0x21c], 1 ; setbe al` at file offset `0x998bd`. The head unit's
`KI_KOMBI_VARIANT` coding maps, through aapd's `codingToInternal`, to an internal
`KombiVariant`: raw 9→0, 10→1, 1..8 and 11→2, 0→3. A KOMBI4 "high" cluster codes
to raw **7 → KombiVariant 2**, so `2 <= 1` is false and the cluster screen is
gated off — the same reason CarPlay needed its variant patch. Raising the
compare immediate to 2 admits KombiVariant 2; KombiVariant 3 (raw 0 / no cluster)
stays off. This single result also feeds `initProjectionBridge` and the Cinemo
display-type setup. The coding is left untouched, so the cluster keeps
describing its real hardware.

### Why selfstart
Even with the gate patched, live DLT capture showed `aapd` setting up the
alternate display (`onAlternateVideoReady`, `subscribeEvents`) and then only
*waiting* for a `ProjectedModeRequestStreamCommand` from the car's native
navigation/HMI stack — which, on this build, never arrives. No video ever
reached AVB stream 15. Same class of stall as CarPlay's missing
NavController forward, one layer deeper.

- **call**: `AlternateDisplays::onNewNavigationStatus()`'s shared tail calls
  `setNaviStreamStatus(this, status)` to notify the nav stack a stream is
  available, but never requests one. Retargeting that `call` to
  `requestStream(this)` (same `this` in rdi; the extra status-pointer arg is
  simply unused by `requestStream`, ABI-safe) makes aapd ask for the stream
  itself as soon as Cinemo's navigation status goes ACTIVE. `requestStream()`
  still calls `setNaviStreamStatus(STREAMING)` from its own tail, so the nav
  stack is still notified.
- **guard**: `requestStream()`'s own entry only proceeds past
  `cmp dword [rbx+0x44], 2 ; je <real work>` when a prior
  `StreamCommandChanged` event set that field — which never happens here.
  Changing the `je` to an unconditional `jmp` (same target, NOP-padded to the
  same 6-byte length) makes it proceed whenever not already streaming
  (`[rbx+0x38] != 2`, left untouched).

### Why size
`ConfigurationManagerInstance::loadKombiDisplayDefinition()` turns
`KombiVariant` into the screen size it looks up in `aapd.conf`
(`KOMBI_DISPLAY` `DIMENSIONS` and `CODEC_SUPPORTED`) with a helper at file
`0x15b400`: 0 → 12.3, 1 → 10.25, anything else → 0.0. With 0.0, or a failed
lookup, it skips `aapd.conf` and builds a default (a 1280x480, 155 dpi panel),
from which the phone gets an **800x480 stream whose UI is its top 800x300**,
black below (measured on the car with the gate and selfstart edits only). So
for KombiVariant 2 no `aapd.conf` edit can reach the phone.

The helper's fall-through for variants other than 0 and 1 is
`pxor xmm0,xmm0 ; jmp <return>` at `0x15b440`, followed by 10 bytes of
alignment padding before the 12.3 load at `0x15b450`. The edit rewrites those
16 bytes as
```
15b440: 83 f8 02        cmp  eax, 2          ; eax still holds the variant
15b443: 74 0b           je   0x15b450        ; the stock "12.3" load
15b445: 66 0f ef c0     pxor xmm0, xmm0      ; any other variant: 0.0, as stock
15b449: eb dc           jmp  0x15b427        ; the stock return
15b44b: 0f 1f 44 00 00  nop
```
The helper's only caller is `loadKombiDisplayDefinition()` (call at
`0x15b742`). `0x525170` holds 12.3 and `0x525178` 10.25. The KOMBI4 high
cluster (KombiVariant 2) is the 12.3" one.

Both selfstart edits are needed together: `call` alone reaches a
`requestStream()` that still no-ops on the unsatisfied guard; `guard` alone
removes a check nothing calls past.

The sites were found by decompiling `aapd` (Ghidra) on the unit's firmware.

## Confirmed on the car (2026-11-02)
The gate and selfstart edits alone, applied and live on a BMW X5 G05 (MGU
P18_23w44): `aapd` sha256
`fb90055dc6c0bbd67a9fa7925033aeae50237111cf6ccedcf429649e2c2145bf`. Render
confirmed showing, thousands of frames decoded, 0 drops.

With those three, the phone sends Google Maps' cluster view (no media icon)
as 800x480 drawn in its top 800x300: aapd's built-in default, since
KombiVariant 2 has no screen size. With the size edit too (0.2.0, then
0.3.0), aapd.conf's geometry reaches the phone: 0.3.0's 1280x720 stream
drawn in its top 1280x564 (`decoder: sequence 1280x720, map from its
1280x564`), the map filling the slot unstretched and the turn card top-centre
inside the safe area, clear of the gauges.

## Safety
- Four small, scoped edits in a BMW binary, reversible, SHA-pinned to the one
  known build (`sha256 6880f54c…`, size 7367952), each validated by anchor
  bytes on both sides, written by atomic rename after a verified full backup
  (`/usr/bin/aapd.aa-orig`). The script refuses an unrecognised or
  inconsistently-modified build.
- The change takes effect the next time aapd starts. Never stop or restart
  aapd by hand: as with carplay, unless recmgr loaded an `aapd` entry at this
  boot its death power-cycles the head unit (2026-11-02: a crashing aapd
  reboot-looped the unit and the HMI came back reset). The Store install
  (`../README.md`) adds that entry and a boot recovery.
- `revert` restores only the edited regions over a recognised patched build,
  keeps other tools' changes, and refuses to overwrite a build it does not
  recognise (e.g. a firmware update) unless given `--force`.
- `--gate-only` applies just the gate edit (the pre-selfstart behaviour), for
  isolating which edit is responsible for anything observed.

## Commands
```
aapd_patch.js status [--target <file>]
aapd_patch.js apply  [--target <file>] [--yes] [--gate-only]
aapd_patch.js verify [--target <file>]
aapd_patch.js revert [--target <file>] [--yes] [--force] [--drop-backup]
```
Default target `/usr/bin/aapd`. Node 8 on the unit, no dependencies.

---

Copyright (C) 2026 mlurker@gmail.com. Licensed GPL-3.0-or-later.
