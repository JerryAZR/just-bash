/**
 * diff - Compare files line by line
 */

import { decodeBytesToUtf8 } from "../../encoding.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { hasHelpFlag, showHelp } from "../help.js";
import {
  computeChanges,
  DEFAULT_CONTEXT,
  formatContext,
  formatNormal,
  formatUnified,
  splitLines,
} from "./format.js";

const diffHelp = {
  name: "diff",
  summary: "compare files line by line",
  usage: "diff [OPTION]... FILE1 FILE2",
  options: [
    "    --normal      output a normal diff (default)",
    "-u, --unified     output a unified diff",
    "-c, --context     output a context diff",
    "-q, --brief       report only whether files differ",
    "-s, --report-identical-files  report when files are the same",
    "-i, --ignore-case  ignore case differences",
    "-r, --recursive   recursively compare directories",
    "-N, --new-file    treat absent files as empty",
    "    --version     output version information and exit",
    "    --help        display this help and exit",
  ],
};

const argDefs = {
  normal: { long: "normal", type: "boolean" as const },
  unified: { short: "u", long: "unified", type: "boolean" as const },
  context: { short: "c", long: "context", type: "boolean" as const },
  brief: { short: "q", long: "brief", type: "boolean" as const },
  reportSame: {
    short: "s",
    long: "report-identical-files",
    type: "boolean" as const,
  },
  ignoreCase: { short: "i", long: "ignore-case", type: "boolean" as const },
  recursive: { short: "r", long: "recursive", type: "boolean" as const },
  newFile: { short: "N", long: "new-file", type: "boolean" as const },
  version: { long: "version", type: "boolean" as const },
};

interface DiffStyle {
  unified: boolean;
  context: boolean;
  brief: boolean;
  reportSame: boolean;
  ignoreCase: boolean;
  newFile: boolean;
}

/** Compare two file contents, return formatted diff output and whether they differ. */
function compareContents(
  label1: string,
  label2: string,
  c1: string,
  c2: string,
  style: DiffStyle,
): { output: string; differs: boolean } {
  let t1 = c1;
  let t2 = c2;
  if (style.ignoreCase) {
    t1 = t1.toLowerCase();
    t2 = t2.toLowerCase();
  }

  if (t1 === t2) {
    if (style.reportSame)
      return {
        output: `Files ${label1} and ${label2} are identical\n`,
        differs: false,
      };
    return { output: "", differs: false };
  }

  if (style.brief) {
    return { output: `Files ${label1} and ${label2} differ\n`, differs: true };
  }

  const oldFile = splitLines(c1);
  const newFile = splitLines(c2);
  const changes = computeChanges(oldFile, newFile, style.ignoreCase);

  let output: string;
  if (style.unified) {
    output = formatUnified(
      label1,
      label2,
      oldFile,
      newFile,
      changes,
      DEFAULT_CONTEXT,
    );
  } else if (style.context) {
    output = formatContext(
      label1,
      label2,
      oldFile,
      newFile,
      changes,
      DEFAULT_CONTEXT,
    );
  } else {
    output = formatNormal(oldFile, newFile, changes);
  }
  return { output, differs: true };
}

/** Read a file from the VFS, resolving relative to cwd. */
async function readVfsFile(
  ctx: RuntimeCommandContext,
  path: string,
): Promise<string> {
  return ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, path));
}

/** Stat a path, returning null on failure. */
async function statOrNull(
  ctx: RuntimeCommandContext,
  path: string,
): Promise<{ isFile: boolean; isDirectory: boolean } | null> {
  try {
    const resolved = ctx.fs.resolvePath(ctx.cwd, path);
    const st = await ctx.fs.stat(resolved);
    return { isFile: st.isFile, isDirectory: st.isDirectory };
  } catch {
    return null;
  }
}

/**
 * Recursively compare two directory trees.
 * Returns accumulated output and whether any differences were found.
 */
async function diffDirectories(
  dir1: string,
  dir2: string,
  ctx: RuntimeCommandContext,
  style: DiffStyle,
): Promise<{ output: string; differs: boolean }> {
  const resolved1 = ctx.fs.resolvePath(ctx.cwd, dir1);
  const resolved2 = ctx.fs.resolvePath(ctx.cwd, dir2);

  const entries1 = (await ctx.fs.readdirWithFileTypes?.(resolved1)) ?? [];
  const entries2 = (await ctx.fs.readdirWithFileTypes?.(resolved2)) ?? [];

  const names1 = new Set(entries1.map((e) => e.name));
  const names2 = new Set(entries2.map((e) => e.name));
  const allNames = [...new Set([...names1, ...names2])].sort();

  const entryMap1 = new Map(entries1.map((e) => [e.name, e]));
  const entryMap2 = new Map(entries2.map((e) => [e.name, e]));

  let output = "";
  let differs = false;

  for (const name of allNames) {
    const path1 = `${dir1}/${name}`;
    const path2 = `${dir2}/${name}`;
    const e1 = entryMap1.get(name);
    const e2 = entryMap2.get(name);

    if (e1 && e2) {
      // In both trees
      if (e1.isDirectory && e2.isDirectory) {
        const sub = await diffDirectories(path1, path2, ctx, style);
        output += sub.output;
        differs = differs || sub.differs;
      } else if (e1.isFile && e2.isFile) {
        try {
          const c1 = await readVfsFile(ctx, path1);
          const c2 = await readVfsFile(ctx, path2);
          const result = compareContents(path1, path2, c1, c2, style);
          if (result.differs && !style.brief && result.output) {
            output += `diff ${path1} ${path2}\n`;
          }
          output += result.output;
          differs = differs || result.differs;
        } catch {
          output += `diff: ${path1}: No such file or directory\n`;
          differs = true;
        }
      } else {
        // Type mismatch
        const t1 = e1.isDirectory ? "directory" : "regular file";
        const t2 = e2.isDirectory ? "directory" : "regular file";
        output += `File ${path1} is a ${t1} while file ${path2} is a ${t2}\n`;
        differs = true;
      }
    } else if (e1) {
      // Only in dir1
      differs = true;
      if (style.newFile) {
        if (e1.isDirectory) {
          const sub = await diffTreeVsEmpty(path1, path2, ctx, style, true);
          output += sub.output;
        } else {
          const c1 = await readVfsFile(ctx, path1);
          const result = compareContents(path1, path2, c1, "", style);
          if (!style.brief && result.output) {
            output += `diff ${path1} ${path2}\n`;
          }
          output += result.output;
        }
      } else {
        output += `Only in ${dir1}: ${name}\n`;
      }
    } else if (e2) {
      // Only in dir2
      differs = true;
      if (style.newFile) {
        if (e2.isDirectory) {
          const sub = await diffTreeVsEmpty(path1, path2, ctx, style, false);
          output += sub.output;
        } else {
          const c2 = await readVfsFile(ctx, path2);
          const result = compareContents(path1, path2, "", c2, style);
          if (!style.brief && result.output) {
            output += `diff ${path1} ${path2}\n`;
          }
          output += result.output;
        }
      } else {
        output += `Only in ${dir2}: ${name}\n`;
      }
    }
  }

  return { output, differs };
}

/**
 * With -N: recursively diff a tree that exists on one side against
 * an empty tree on the other. All files show as full additions or deletions.
 */
async function diffTreeVsEmpty(
  treePath: string,
  emptyPath: string,
  ctx: RuntimeCommandContext,
  style: DiffStyle,
  treeIsFirst: boolean,
): Promise<{ output: string }> {
  const resolved = ctx.fs.resolvePath(ctx.cwd, treePath);
  const entries = (await ctx.fs.readdirWithFileTypes?.(resolved)) ?? [];
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

  let output = "";
  for (const entry of sorted) {
    const tp = `${treePath}/${entry.name}`;
    const ep = `${emptyPath}/${entry.name}`;
    if (entry.isDirectory) {
      const sub = await diffTreeVsEmpty(tp, ep, ctx, style, treeIsFirst);
      output += sub.output;
    } else if (entry.isFile) {
      const content = await readVfsFile(ctx, tp);
      const c1 = treeIsFirst ? content : "";
      const c2 = treeIsFirst ? "" : content;
      const result = compareContents(tp, ep, c1, c2, style);
      if (!style.brief && result.output) {
        output += `diff ${tp} ${ep}\n`;
      }
      output += result.output;
    }
  }
  return { output };
}

export const diffCommand: RuntimeCommand = {
  name: "diff",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    if (hasHelpFlag(args)) return showHelp(diffHelp);

    const parsed = parseArgs("diff", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const flags = parsed.result.flags;
    if (flags.version) {
      // No version number: this command ships inside just-bash and has no
      // release cadence of its own, and a hard-coded package version would go
      // stale on the very next release.
      return { stdout: "diff (just-bash)\n", stderr: "", exitCode: 0 };
    }

    const styleCount =
      Number(flags.normal) + Number(flags.unified) + Number(flags.context);
    if (styleCount > 1) {
      return {
        stdout: "",
        stderr:
          "diff: conflicting output style options\n" +
          "diff: Try 'diff --help' for more information.\n",
        exitCode: 2,
      };
    }

    const style: DiffStyle = {
      unified: flags.unified,
      context: flags.context,
      brief: flags.brief,
      reportSame: flags.reportSame,
      ignoreCase: flags.ignoreCase,
      newFile: flags.newFile,
    };

    const files = parsed.result.positional;

    if (files.length < 2) {
      return { stdout: "", stderr: "diff: missing operand\n", exitCode: 2 };
    }

    const [f1, f2] = files;

    // Recursive mode: both args must be directories (or one file + one dir,
    // where the file's basename is appended to the dir).
    if (flags.recursive) {
      const s1 = await statOrNull(ctx, f1);
      const s2 = await statOrNull(ctx, f2);

      if (s1?.isFile && s2?.isDirectory) {
        // File vs dir: compare file against dir/basename — two-file diff
        const f2Resolved = `${f2}/${f1.split("/").pop()}`;
        const c1 = await readVfsFile(ctx, f1);
        let c2: string;
        try {
          c2 = await readVfsFile(ctx, f2Resolved);
        } catch {
          return {
            stdout: `Only in ${f1.split("/").slice(0, -1).join("/") || "."}: ${f1.split("/").pop()}\n`,
            stderr: "",
            exitCode: 1,
          };
        }
        const result = compareContents(f1, f2Resolved, c1, c2, style);
        return {
          stdout: result.output,
          stderr: "",
          exitCode: result.differs ? 1 : 0,
        };
      }
      if (s1?.isDirectory && s2?.isFile) {
        const f1Resolved = `${f1}/${f2.split("/").pop()}`;
        let c1: string;
        try {
          c1 = await readVfsFile(ctx, f1Resolved);
        } catch {
          return {
            stdout: `Only in ${f2.split("/").slice(0, -1).join("/") || "."}: ${f2.split("/").pop()}\n`,
            stderr: "",
            exitCode: 1,
          };
        }
        const c2 = await readVfsFile(ctx, f2);
        const result = compareContents(f1Resolved, f2, c1, c2, style);
        return {
          stdout: result.output,
          stderr: "",
          exitCode: result.differs ? 1 : 0,
        };
      }

      if (!s1 || !s2) {
        const missing = !s1 ? f1 : f2;
        return {
          stdout: "",
          stderr: `diff: ${missing}: No such file or directory\n`,
          exitCode: 2,
        };
      }

      if (s1.isDirectory && s2.isDirectory) {
        const result = await diffDirectories(f1, f2, ctx, style);
        return {
          stdout: result.output,
          stderr: "",
          exitCode: result.differs ? 1 : 0,
        };
      }
      // Both files with -r: fall through to regular file diff
    }

    // Two-file mode (also reached by -r when both args are files)
    let c1: string;
    let c2: string;

    // diff compares lines as strings. Normalize stdin (byte buffer) to
    // UTF-8 so it compares correctly against file content (utf8 by default).
    try {
      c1 =
        f1 === "-" ? decodeBytesToUtf8(ctx.stdin) : await readVfsFile(ctx, f1);
    } catch {
      if (style.newFile) {
        c1 = "";
      } else {
        return {
          stdout: "",
          stderr: `diff: ${f1}: No such file or directory\n`,
          exitCode: 2,
        };
      }
    }

    try {
      c2 =
        f2 === "-" ? decodeBytesToUtf8(ctx.stdin) : await readVfsFile(ctx, f2);
    } catch {
      if (style.newFile) {
        c2 = "";
      } else {
        return {
          stdout: "",
          stderr: `diff: ${f2}: No such file or directory\n`,
          exitCode: 2,
        };
      }
    }

    const result = compareContents(f1, f2, c1, c2, style);
    return {
      stdout: result.output,
      stderr: "",
      exitCode: result.differs ? 1 : 0,
    };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "diff",
  flags: [
    { flag: "--normal", type: "boolean" },
    { flag: "-u", type: "boolean" },
    { flag: "-c", type: "boolean" },
    { flag: "-q", type: "boolean" },
    { flag: "-s", type: "boolean" },
    { flag: "-i", type: "boolean" },
    { flag: "-r", type: "boolean" },
    { flag: "-N", type: "boolean" },
  ],
  needsArgs: true,
  minArgs: 2,
};
