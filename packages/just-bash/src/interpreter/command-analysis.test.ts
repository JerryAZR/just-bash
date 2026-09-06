import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { ParseException } from "../parser/types.js";
import { BUILTIN_MANIFEST, SHELL_BUILTINS } from "./builtin-manifest.js";
import { POSIX_SPECIAL_BUILTINS } from "./helpers/shell-constants.js";

describe("analyzeCommands", () => {
  it("collects literal command names and reports unresolved ones", async () => {
    const bash = new Bash();
    const analysis = await bash.analyzeCommands(
      "grep -r foo src/ && nosuchcmd status",
    );
    expect(analysis.commands).toEqual(["grep", "nosuchcmd"]);
    expect(analysis.unresolved).toEqual(["nosuchcmd"]);
  });

  it("collects names from functions, subshells, compounds, and substitutions", async () => {
    const bash = new Bash();
    const analysis = await bash.analyzeCommands(
      [
        "f() { inner_fn; }; f",
        "( inner_sub )",
        "if inner_cond; then inner_then; fi",
        "for x in $(inner_subst); do inner_loop; done",
        "inner_pipe | inner_sink",
      ].join("\n"),
    );
    expect(analysis.commands).toEqual([
      "inner_fn",
      "f",
      "inner_sub",
      "inner_cond",
      "inner_then",
      "inner_subst",
      "inner_loop",
      "inner_pipe",
      "inner_sink",
    ]);
    // f resolves: defined within the analyzed script itself.
    expect(analysis.unresolved).not.toContain("f");
    expect(analysis.unresolved).toContain("inner_fn");
  });

  it("does not flag script-defined functions as unresolved", async () => {
    const bash = new Bash();
    const analysis = await bash.analyzeCommands(
      "deploy() { echo ok; }; deploy prod",
    );
    expect(analysis.unresolved).toEqual([]);
  });

  it("does not flag builtins or registered commands", async () => {
    const bash = new Bash();
    const analysis = await bash.analyzeCommands(
      "echo hi | grep h; export X=1; cd /tmp; printf '%s' done",
    );
    expect(analysis.unresolved).toEqual([]);
  });

  it("matches runtime behavior for functions from prior execs", async () => {
    // just-bash isolates state per exec(): functions defined in one exec
    // do not persist to the next, so they correctly report as unresolved —
    // they would not resolve at dispatch time either.
    const bash = new Bash();
    await bash.exec("myfunc() { echo defined; }");
    const analysis = await bash.analyzeCommands("myfunc; otherfunc");
    expect(analysis.unresolved).toEqual(["myfunc", "otherfunc"]);
  });

  it("resolves executable files on the VFS PATH", async () => {
    const bash = new Bash({
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      files: {
        "/usr/local/bin/deploy.sh": {
          content: "#!/bin/sh\necho deploy\n",
          mode: 0o755,
        },
      },
    });
    const analysis = await bash.analyzeCommands("deploy.sh prod; missing.sh");
    expect(analysis.unresolved).toEqual(["missing.sh"]);
  });

  it("omits dynamically determined names", async () => {
    const bash = new Bash();
    const analysis = await bash.analyzeCommands(
      'cmd=nosuchcmd; $cmd status; eval "nosucheval x"; "quotedcmd"',
    );
    // eval itself is a literal (and resolves); the dynamic names are
    // invisible to static analysis and appear in neither list.
    expect(analysis.commands).toEqual(["eval"]);
    expect(analysis.unresolved).toEqual([]);
  });

  it("analyzes without executing or modifying state", async () => {
    const bash = new Bash();
    const before = await bash.exec("echo $STATE_MARKER");
    await bash.analyzeCommands(
      "STATE_MARKER=set; nosuchcmd; echo $(nosuchsub)",
    );
    const after = await bash.exec("echo $STATE_MARKER");
    expect(before.stdout).toBe(after.stdout);
    // No miss was dispatched, so nothing was recorded.
    const result = await bash.exec("true");
    expect(result.unresolvedCommands).toEqual([]);
  });

  it("throws ParseException on syntax errors", async () => {
    const bash = new Bash();
    await expect(bash.analyzeCommands("if true; then")).rejects.toThrow(
      ParseException,
    );
  });

  it("collects commands inside redirection target substitutions", async () => {
    const bash = new Bash();
    const analysis = await bash.analyzeCommands("cat > $(missingcmd)");
    expect(analysis.commands).toEqual(["cat", "missingcmd"]);
    expect(analysis.unresolved).toEqual(["missingcmd"]);
  });

  it("treats script-defined alias names as resolved", async () => {
    const bash = new Bash();
    const analysis = await bash.analyzeCommands("alias ll='ls -l'; ll /tmp");
    expect(analysis.commands).toEqual(["alias", "ll"]);
    expect(analysis.unresolved).toEqual([]);
  });

  it("agrees with runtime dispatch for every builtin-looking name", async () => {
    // Parity pin: for each name in the builtin display sets, runtime
    // dispatch and static analysis must agree on resolvability. Any drift
    // (a builtin implemented later, or a set edited without the other
    // being updated) fails this test loudly.
    const bash = new Bash();
    const names = [...POSIX_SPECIAL_BUILTINS, ...SHELL_BUILTINS];
    const divergent: string[] = [];
    for (const name of names) {
      const runtime = await bash.exec(name);
      const runtimeMissing = runtime.stderr.includes("command not found");
      const analysis = await bash.analyzeCommands(name);
      const analysisMissing = analysis.unresolved.includes(name);
      if (runtimeMissing !== analysisMissing) {
        divergent.push(
          `${name} (runtime ${runtimeMissing ? "missing" : "resolves"}, analysis ${analysisMissing ? "missing" : "resolves"})`,
        );
      }
    }
    expect(divergent).toEqual([]);
  });

  it("does not see substitutions in [[ ]] conditions (documented limitation)", async () => {
    // Conditional-command test expressions are not walked: a substitution
    // there does execute at runtime, and the runtime backstop
    // (unresolvedCommands) is the documented answer for this blind spot.
    const bash = new Bash();
    const analysis = await bash.analyzeCommands("[[ -n $(missingcmd) ]]");
    expect(analysis.commands).toEqual([]);
    expect(analysis.unresolved).toEqual([]);
  });

  it("every manifest name has a help entry (manifest ⊆ BUILTIN_HELP)", async () => {
    // help may document MORE than the manifest (e.g. bash builtins we do
    // not implement), but a manifest name without help is a drift bug —
    // `type X` says builtin while `help X` fails.
    const { BUILTIN_HELP } = await import("./builtins/help.js");
    const missing = Object.keys(BUILTIN_MANIFEST).filter(
      (name) => !BUILTIN_HELP.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("resolves functions regardless of definition order (documented divergence)", async () => {
    // Static collection is order-insensitive; dispatch is not. `f` fails
    // at runtime here (defined after use) but analysis reports it
    // resolved. Pinned so the divergence is deliberate, not accidental.
    const bash = new Bash();
    const analysis = await bash.analyzeCommands("f; f() { :; }");
    expect(analysis.unresolved).toEqual([]);
    const runtime = await bash.exec("f; f() { :; }");
    expect(runtime.stderr).toContain("f: command not found");
  });
});
