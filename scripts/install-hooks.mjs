// Runs on `bun install` (the prepare script): points git at the checked-in hooks in .githooks/ (gitleaks plus
// `bun run check` before each commit, gitleaks over the pushed commits before each push). Outside a git checkout,
// such as an unpacked tarball, it does nothing.
import { spawnSync } from "node:child_process";

const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
if (inside.status === 0 && inside.stdout.trim() === "true") {
  spawnSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
}
