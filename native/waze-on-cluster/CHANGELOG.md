# Changelog

## Unreleased

CarPlay's cluster map patch is applied in CarPlay's memory each time it
starts, and `/usr/bin/carplay` stays as it ships: no write of the system
partition to patch, remove or recover it. Updating from an earlier version
puts the original file back and keeps the map, with at most one head-unit
restart; where CarPlay already runs the earlier patch, none. The earlier
patch stays in the file where the file holds another change besides it,
where boot recovery counts a failed start, or where the patch in memory
cannot be set up.

## 0.10.12

The diagnostic journal is kept in memory and written to storage only around
failures and at shutdown, which greatly reduces writes to the head unit's
storage.

