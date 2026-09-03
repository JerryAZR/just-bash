import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

describe("unresolved command reporting", () => {
  it("records a miss while preserving bash-fidelity behavior", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo hi; nosuchcmd --flag; echo done");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\ndone\n");
    expect(result.stderr).toBe("bash: nosuchcmd: command not found\n");
    expect(result.unresolvedCommands).toEqual(["nosuchcmd"]);
  });

  it("dedupes repeated misses in first-encountered order", async () => {
    const bash = new Bash();
    const result = await bash.exec("cmda; cmdb; cmda; cmdc; cmdb; cmda");
    expect(result.unresolvedCommands).toEqual(["cmda", "cmdb", "cmdc"]);
  });

  it("is empty when every command resolves", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo hello | cat; true");
    expect(result.unresolvedCommands).toEqual([]);
  });

  it("captures misses from functions, subshells, pipelines, and substitutions", async () => {
    const bash = new Bash();
    const result = await bash.exec(
      [
        "f() { miss_fn; }; f",
        "( miss_sub )",
        "miss_pipe | cat",
        "x=$(miss_subst)",
      ].join("; "),
    );
    expect(result.unresolvedCommands).toEqual([
      "miss_fn",
      "miss_sub",
      "miss_pipe",
      "miss_subst",
    ]);
  });

  it("captures misses from nested bash -c", async () => {
    const bash = new Bash();
    const result = await bash.exec('bash -c "echo inner; miss_nested"');
    expect(result.unresolvedCommands).toEqual(["miss_nested"]);
  });

  it("records misses even when the script handles them", async () => {
    const bash = new Bash();
    const result = await bash.exec("nosuchcmd || echo fallback; echo rc=$?");
    expect(result.stdout).toBe("fallback\nrc=0\n");
    expect(result.unresolvedCommands).toEqual(["nosuchcmd"]);
  });

  it("does not record resolution probes", async () => {
    const bash = new Bash();
    const result = await bash.exec(
      "command -v nosuchcmd || echo absent; type nosuchcmd 2>/dev/null || true",
    );
    expect(result.stdout).toBe("absent\n");
    expect(result.unresolvedCommands).toEqual([]);
  });

  it("does not record explicit-path misses", async () => {
    const bash = new Bash();
    const result = await bash.exec("./missing.sh; /bin/alsomissing");
    expect(result.unresolvedCommands).toEqual([]);
  });

  it("does not record permission-denied (the name resolved)", async () => {
    const bash = new Bash({
      files: { "/noexec.sh": { content: "echo hi\n", mode: 0o644 } },
    });
    const result = await bash.exec("chmod 644 /noexec.sh; /noexec.sh");
    expect(result.exitCode).not.toBe(0);
    expect(result.unresolvedCommands).toEqual([]);
  });
});

describe("abortOnUnresolvedCommands", () => {
  it("aborts at the first miss with 127 and preserves output so far", async () => {
    const bash = new Bash({ abortOnUnresolvedCommands: true });
    const result = await bash.exec("echo before; nosuchcmd; echo after");
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("before\n");
    expect(result.stderr).toBe("bash: nosuchcmd: command not found\n");
    expect(result.unresolvedCommands).toEqual(["nosuchcmd"]);
  });

  it("unwinds past || handlers", async () => {
    const bash = new Bash({ abortOnUnresolvedCommands: true });
    const result = await bash.exec("nosuchcmd || echo handled; echo after");
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.unresolvedCommands).toEqual(["nosuchcmd"]);
  });

  it("unwinds out of subshells and functions", async () => {
    const bash = new Bash({ abortOnUnresolvedCommands: true });
    const result = await bash.exec(
      "f() { ( echo deep; nosuchcmd ); echo no; }; f; echo after",
    );
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("deep\n");
    expect(result.unresolvedCommands).toEqual(["nosuchcmd"]);
  });

  it("nested bash -c abort unwinds the outer exec", async () => {
    const bash = new Bash({ abortOnUnresolvedCommands: true });
    const result = await bash.exec('echo top; bash -c "nosuchcmd"; echo after');
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("top\n");
    expect(result.unresolvedCommands).toEqual(["nosuchcmd"]);
  });

  it("does not affect scripts where everything resolves", async () => {
    const bash = new Bash({ abortOnUnresolvedCommands: true });
    const result = await bash.exec("echo ok | cat");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok\n");
    expect(result.unresolvedCommands).toEqual([]);
  });
});

describe("abort unwind coverage", () => {
  const abortBash = () => new Bash({ abortOnUnresolvedCommands: true });

  it.each([
    ["for loop", "for i in 1 2 3; do nosuchcmd; done; echo after"],
    ["while loop", "while true; do nosuchcmd; done; echo after"],
    [
      "until loop",
      "i=0; until [ $i -ge 3 ]; do nosuchcmd; i=$((i+1)); done; echo after",
    ],
    ["C-style for", "for ((i=0; i<3; i++)); do nosuchcmd; done; echo after"],
    ["if condition", "if nosuchcmd; then echo x; fi; echo after"],
    [
      "while condition",
      "i=0; while nosuchcmd; do i=$((i+1)); done; echo after",
    ],
    ["&& list", "nosuchcmd && echo x; echo after"],
    ["pipeline", "nosuchcmd | cat; echo after"],
    ["command substitution", "x=$(nosuchcmd); echo after"],
    ["substitution in argument", "echo before $(nosuchcmd) middle; echo after"],
  ])("aborts out of %s", async (_label, script) => {
    const result = await abortBash().exec(script);
    expect(result.exitCode).toBe(127);
    expect(result.stdout).not.toContain("after");
    expect(result.unresolvedCommands).toEqual(["nosuchcmd"]);
  });

  it("aborts out of command substitution inside extglob patterns", async () => {
    const result = await abortBash().exec(
      "shopt -s extglob; echo @($(nosuchcmd)|x); echo after",
    );
    expect(result.exitCode).toBe(127);
    expect(result.stdout).not.toContain("after");
    expect(result.unresolvedCommands).toEqual(["nosuchcmd"]);
  });

  it("preserves stderr accumulated before the miss", async () => {
    const result = await abortBash().exec("echo oops >&2; nosuchcmd");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe("oops\nbash: nosuchcmd: command not found\n");
  });

  it("records misses across nested bash -c scopes in encounter order", async () => {
    const bash = new Bash();
    const result = await bash.exec("nosuch1; bash -c 'nosuch2'; nosuch1");
    expect(result.exitCode).toBe(127);
    expect(result.unresolvedCommands).toEqual(["nosuch1", "nosuch2"]);
  });

  it("a handled miss still exits 127 for that command", async () => {
    const bash = new Bash();
    const result = await bash.exec("nosuchcmd; echo status=$?");
    expect(result.stdout).toBe("status=127\n");
    expect(result.unresolvedCommands).toEqual(["nosuchcmd"]);
  });
});
