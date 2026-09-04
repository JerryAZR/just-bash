---
"@jerryan/just-bash": minor
---

`rm -f` now suppresses only ENOENT errors, matching GNU rm: mount-point (EBUSY) and other failures are reported and exit 1 instead of being silently swallowed. Previously `rm -rf` on a mount point or its parent was a silent no-op with exit 0, while the change set correctly showed nothing had been deleted.

`AgentSandbox` gains path conversion helpers: `resolveRealPath(realPath)` maps a real host path to `{ mountPoint, overlay, path }` for direct shadow inspection on the overlay, and `toRealPath(vfsPath)` maps a VFS path to its real host path. Both return null for paths outside the mounted overlays.
