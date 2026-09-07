import { Bash } from './dist/index.js';
const cases = [
  ['extglob basic', "shopt -s extglob; [[ abc == @(a|b)c ]]; echo rc=$?"],
  ['extglob nocasematch', "shopt -s nocasematch extglob; [[ ABC == @(a|b)c ]]; echo rc=$?"],
  ['nested ternary in parens', "echo $(( (1 ? 2 : 0 ? 3 : 4) + 0 ))"],
  ['expand -t 0,', "printf 'a\tb\n' | expand -t 0,"],
  ['awk scientific inf', "awk 'BEGIN{printf \"%e\n\", 1e999}'"],
  ['printf inf', "printf '%e\n' 1e999"],
  ['A=1 [[ x = y ]]', "A=1 [[ x = y ]]; echo rc=$?"],
  ['empty ksh ${ ;}', "echo ${ ;}; echo rc=$?"],
  ['ksh ${ case...; }', "x=a; echo ${ case $x in (a) echo yes;; esac }; echo rc=$?"],
  ['expand -t 0', "printf 'a\tb\n' | expand -t 0"],
];
const bash = new Bash();
for (const [name, script] of cases) {
  try {
    const r = await bash.exec(script);
    console.log(`=== ${name}\n  exit=${r.exitCode} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  } catch (e) {
    console.log(`=== ${name}\n  THREW ${(e.message||'').slice(0,120)}`);
  }
}
