import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

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
    await expect(bash.analyzeCommands("if true; then")).rejects.toThrow();
  });
});
