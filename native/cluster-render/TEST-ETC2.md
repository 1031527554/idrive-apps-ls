# ETC2 car test

Checks that the cluster draws `etc2rgba` assets (PROTOCOL.md): ETC2 RGBA
with EAC alpha, 1 byte a pixel.

| Test | iDrive 7 (G20) | iDrive 8 |
|---|---|---|
| 1. a 252x280 frame beside the same frame as rgba8 | HUD: drawn, the same as the rgba8 one | not run |
| 2. a 2048x1024 atlas, whole and panned at 1:1 | HUD and cluster (`panel`): drawn | not run |
| 3. a 2048x2048 atlas, whole and panned at 1:1 | HUD and cluster: drawn | not run |

## Files

- Client: `tools/etc2_test/etc2_client.js` (Node 8, no deps) with
  `js/cluster_render_client.js`.
- Test images, from an RGBA atlas and its `atlas.json` with a `close`
  section (not in the repository):

  ```sh
  python3 tools/etc2_test/etc2_encode.py frame <close.rgba> <atlas.json> <dir>   # test 1: frame.rgba, frame.etc2, frame.json
  python3 tools/etc2_test/etc2_encode.py atlas <close.rgba> <atlas.json> <dir>   # test 2: atlas.etc2, atlas.json
  ```

  Test 2's atlas is the source atlas twice side by side, a bar along the
  bottom of each copy (red left, green right) and a white 4 px frame round
  the whole: 2048x1024, 2,097,152 bytes.

## Steps

1. Install a kit built from the working tree (README.md "Install").

2. Copy the files to the unit (`UNIT` is its address):

   ```sh
   ssh root@UNIT mkdir -p /tmp/etc2
   scp native/cluster-render/tools/etc2_test/etc2_client.js native/cluster-render/js/cluster_render_client.js \
       <dir>/frame.rgba <dir>/frame.etc2 <dir>/frame.json <dir>/atlas.etc2 <dir>/atlas.json root@UNIT:/tmp/etc2/
   ```

3. Turn off other HUD apps, the HUD on. In one ssh session follow the log:

   ```sh
   tail -f /var/opt/cluster-render/log/cluster-render.log | grep -E 'etc2|asset|hud|went away|ramses'
   ```

   In another, run one test at a time; Ctrl+C ends it:

   ```sh
   /usr/bin/node /tmp/etc2/etc2_client.js /tmp/etc2                 # test 1: rgba8 left, etc2rgba right
   /usr/bin/node /tmp/etc2/etc2_client.js /tmp/etc2 --atlas         # test 2: the whole 2048x1024, scaled to 560x280
   /usr/bin/node /tmp/etc2/etc2_client.js /tmp/etc2 --atlas --pan   # test 2: a 560x280 window at 1:1, drifting over it
   ```

## What to look for

Test 1: the right frame the same as the left (ETC2 a bit blockier in
colour). Test 2, `--atlas`: the whole atlas twice, the white frame on all
four sides, the red and green bars; `--pan`: the window drifts over every
part of it, sharp. Log: `asset N: 2048x1024 etc2rgba texture made, 2097152
bytes`; client: the layer `shown`.

| You see | Means |
|---|---|
| As above, the layers `shown` | Drawn |
| Blank, the layer `error - asset N: the renderer refused ...` | RAMSES on the head unit refused the texture (the log has `ramses: ... refused by createTexture2D`) |
| Blank, the layer `shown`, no restart | The cluster took the scene and did not draw the texture: too big, or the format unsupported |
| The left half right, the right half or the far edges garbage or missing | The cluster draws only part of a 2048 px texture: keep atlases at 1024 |
| `REFUSED asset ...: format must be ...` | A build without `etc2rgba` is running: redo step 1 |
| HUD (and cluster) blank, KOMBI restarts | The cluster choked on it; the log has `target hud: the display service went away … after its mapping`. Stop the client |

Afterwards, `rm -rf /tmp/etc2` on the unit, turn the HUD apps back on, and
install a release from the Store.
