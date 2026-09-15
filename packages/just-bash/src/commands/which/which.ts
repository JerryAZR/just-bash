/**
 * which - Locate a command
 *
 * Resolution order:
 * 1. VFS PATH search (sandboxed filesystem)
 * 2. Shell builtins (echo, cd, etc.) — only when no file found
 *
 * On miss, prints a helpful message to stderr explaining that the
 * command is not available in this sandboxed bash environment.
 */

import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { hasHelpFlag, showHelp } from "../help.js";

const whichHelp = {
  name: "which",
  summary: "locate a command",
  usage: "which [-as] program ...",
  options: [
    "-a         List all instances of executables found",
    "-s         No output, just return 0 if found, 1 if not",
    "--help     display this help and exit",
  ],
};

const argDefs = {
  showAll: { short: "a", type: "boolean" as const },
  silent: { short: "s", type: "boolean" as const },
};

/** Check if a command is a shell builtin. Lazily imported to avoid circular deps. */
let shellBuiltins: Set<string> | null = null;
async function getShellBuiltins(): Promise<Set<string>> {
  if (!shellBuiltins) {
    const mod = await import("../../interpreter/builtin-manifest.js");
    shellBuiltins = mod.SHELL_BUILTINS;
  }
  return shellBuiltins;
}

export const whichCommand: RuntimeCommand = {
  name: "which",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(whichHelp);
    }

    const parsed = parseArgs("which", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const showAll = parsed.result.flags.showAll;
    const silent = parsed.result.flags.silent;
    const names = parsed.result.positional;

    if (names.length === 0) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }

    const builtins = await getShellBuiltins();
    const pathEnv = ctx.env.get("PATH") || "/usr/bin:/bin";
    const pathDirs = pathEnv.split(":");

    let stdout = "";
    let stderr = "";
    let allFound = true;

    for (const name of names) {
      let found = false;

      // Search VFS PATH first (like real which — external command, only
      // knows about files, not builtins)
      for (const dir of pathDirs) {
        if (!dir) continue;
        const fullPath = ctx.fs.resolvePath(dir, name);
        if (await ctx.fs.exists(fullPath)) {
          found = true;
          if (!silent) {
            stdout += `${fullPath}\n`;
          }
          if (!showAll) {
            break;
          }
        }
      }

      // If no file found, check if it's a shell builtin
      if (!found && builtins.has(name)) {
        found = true;
        if (!silent) {
          stdout += `${name}: shell builtin\n`;
        }
      }

      if (!found) {
        if (!silent) {
          stderr += `which: no ${name} in this sandboxed bash environment\n`;
        }
        allFound = false;
      }
    }

    return {
      stdout,
      stderr,
      exitCode: allFound ? 0 : 1,
    };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "which",
  flags: [
    { flag: "-a", type: "boolean" },
    { flag: "-s", type: "boolean" },
  ],
  needsArgs: true,
};
