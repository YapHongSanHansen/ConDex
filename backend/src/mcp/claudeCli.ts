import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Shows a path without the person's name in it: the home folder becomes $HOME, which a shell expands
 * inside double quotes. Paths outside the home folder are returned unchanged.
 */
export function displayPath(path: string, home = homedir()): string {
  if (home && (path === home || path.startsWith(home + "/") || path.startsWith(home + "\\"))) {
    return "$HOME" + path.slice(home.length);
  }
  return path;
}

export interface ClaudeCli {
  /** Full path when `claude` is on this computer's PATH, else null. */
  onPath: string | null;
  /** Full path to a Claude Code CLI found elsewhere (VS Code extension or the local install), else null. */
  fallback: string | null;
}

/** Looks for the Claude Code CLI so the console can say what to do when a terminal reports "command not found". */
export function findClaudeCli(env: NodeJS.ProcessEnv = process.env, home = homedir()): ClaudeCli {
  let onPath: string | null = null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    if (existsSync(candidate)) { onPath = candidate; break; }
  }

  let fallback: string | null = null;
  const local = join(home, ".claude", "local", "claude");
  if (existsSync(local)) fallback = local;

  const extDir = join(home, ".vscode", "extensions");
  try {
    const versions = readdirSync(extDir).filter((n) => n.startsWith("anthropic.claude-code-")).sort().reverse();
    for (const v of versions) {
      const bin = join(extDir, v, "resources", "native-binary", process.platform === "win32" ? "claude.exe" : "claude");
      if (existsSync(bin)) { fallback = bin; break; }
    }
  } catch {
    /* no VS Code extensions folder */
  }
  return { onPath: onPath && displayPath(onPath, home), fallback: fallback && displayPath(fallback, home) };
}
