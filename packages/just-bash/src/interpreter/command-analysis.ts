/**
 * Static command analysis: walks a parsed program and collects command
 * names without executing anything. Used by Bash.analyzeCommands() for
 * pre-flight checks of which commands a script would dispatch, and by
 * CommandCollectorPlugin for transform metadata.
 */
import type {
  CommandNode,
  ParameterExpansionPart,
  PipelineNode,
  ScriptNode,
  StatementNode,
  WordNode,
  WordPart,
} from "../ast/types.js";

/**
 * Literal command names and function definitions collected from an AST.
 */
export interface CollectedCommands {
  /**
   * Every literal simple-command name, deduplicated in first-encountered
   * order. Names requiring expansion (variables, command substitution,
   * globs, quotes) are not statically knowable and are omitted.
   */
  commands: string[];
  /** Names of functions defined in the analyzed script, deduplicated. */
  definedFunctions: Set<string>;
  /** Names of aliases defined in the analyzed script (`alias name=...`). */
  definedAliases: Set<string>;
}

interface Collector {
  commands: Set<string>;
  definedFunctions: Set<string>;
  definedAliases: Set<string>;
}

/**
 * Collect literal command names and function definitions from a parsed
 * program. Walks the full AST — top-level lists, pipelines, function
 * bodies, subshells, compound-command bodies (if/for/while/until/case/
 * brace groups), and command/process substitution bodies — without
 * executing anything or touching interpreter state.
 */
export function collectCommands(script: ScriptNode): CollectedCommands {
  const collector: Collector = {
    commands: new Set(),
    definedFunctions: new Set(),
    definedAliases: new Set(),
  };
  walkScript(script, collector);
  return {
    commands: [...collector.commands],
    definedFunctions: collector.definedFunctions,
    definedAliases: collector.definedAliases,
  };
}

/**
 * A word is a statically knowable command name only when it is a plain
 * literal: expansions ($, backticks), globs, quotes, and other shell
 * metacharacters make the resolved name depend on runtime state.
 */
function literalCommandName(word: WordNode): string | null {
  if (word.parts.length === 1 && word.parts[0].type === "Literal") {
    return word.parts[0].value;
  }
  return null;
}

/**
 * Collect alias names defined by an `alias name=value ...` invocation.
 * The name must be a literal prefix up to '='; the value may be quoted or
 * compound and is irrelevant here. Non-assignment forms (`alias`,
 * `alias name`) define nothing.
 */
function collectAliasDefinitions(args: WordNode[], c: Collector): void {
  for (const arg of args) {
    const first = arg.parts[0];
    if (first?.type !== "Literal") continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(first.value);
    if (match) c.definedAliases.add(match[1]);
  }
}

function walkScript(node: ScriptNode, c: Collector): void {
  for (const stmt of node.statements) {
    walkStatement(stmt, c);
  }
}

function walkStatement(node: StatementNode, c: Collector): void {
  for (const pipeline of node.pipelines) {
    walkPipeline(pipeline, c);
  }
}

function walkPipeline(node: PipelineNode, c: Collector): void {
  for (const cmd of node.commands) {
    walkCommand(cmd, c);
  }
}

function walkCommand(node: CommandNode, c: Collector): void {
  switch (node.type) {
    case "SimpleCommand":
      if (node.name) {
        const name = literalCommandName(node.name);
        if (name) {
          c.commands.add(name);
          // `alias name=value` defines an alias; dispatch expands those
          // names, so analysis must treat them as resolvable (symmetric
          // with function definitions).
          if (name === "alias") collectAliasDefinitions(node.args, c);
        }
        walkWordParts(node.name.parts, c);
      }
      for (const arg of node.args) {
        walkWordParts(arg.parts, c);
      }
      for (const assign of node.assignments) {
        if (assign.value) walkWordParts(assign.value.parts, c);
        if (assign.array) {
          for (const w of assign.array) {
            walkWordParts(w.parts, c);
          }
        }
      }
      // Redirection targets and heredoc bodies can contain substitutions
      // that execute at runtime (`cat > $(cmd)`, `cat <<EOF ... EOF`).
      for (const redir of node.redirections) {
        if (redir.target.type === "Word") {
          walkWordParts(redir.target.parts, c);
        } else if (redir.target.type === "HereDoc" && !redir.target.quoted) {
          walkWordParts(redir.target.content.parts, c);
        }
      }
      break;
    case "If":
      for (const clause of node.clauses) {
        for (const s of clause.condition) walkStatement(s, c);
        for (const s of clause.body) walkStatement(s, c);
      }
      if (node.elseBody) {
        for (const s of node.elseBody) walkStatement(s, c);
      }
      break;
    case "For":
      if (node.words) {
        for (const w of node.words) {
          walkWordParts(w.parts, c);
        }
      }
      for (const s of node.body) walkStatement(s, c);
      break;
    case "CStyleFor":
      for (const s of node.body) walkStatement(s, c);
      break;
    case "While":
    case "Until":
      for (const s of node.condition) walkStatement(s, c);
      for (const s of node.body) walkStatement(s, c);
      break;
    case "Case":
      walkWordParts(node.word.parts, c);
      for (const item of node.items) {
        for (const s of item.body) walkStatement(s, c);
      }
      break;
    case "Subshell":
    case "Group":
      for (const s of node.body) walkStatement(s, c);
      break;
    case "ArithmeticCommand":
    case "ConditionalCommand":
      // (( ... )) and [[ ... ]] evaluate expressions; they dispatch no commands.
      break;
    case "FunctionDef":
      c.definedFunctions.add(node.name);
      walkCommand(node.body, c);
      break;
  }
}

function walkWordParts(parts: WordPart[], c: Collector): void {
  for (const part of parts) {
    switch (part.type) {
      case "CommandSubstitution":
        walkScript(part.body, c);
        break;
      case "ProcessSubstitution":
        walkScript(part.body, c);
        break;
      case "DoubleQuoted":
        walkWordParts(part.parts, c);
        break;
      case "ParameterExpansion":
        if (part.operation) {
          walkParameterOp(part.operation, c);
        }
        break;
    }
  }
}

function walkParameterOp(
  op: NonNullable<ParameterExpansionPart["operation"]>,
  c: Collector,
): void {
  switch (op.type) {
    case "DefaultValue":
    case "AssignDefault":
    case "UseAlternative":
      walkWordParts(op.word.parts, c);
      break;
    case "ErrorIfUnset":
      if (op.word) walkWordParts(op.word.parts, c);
      break;
    case "PatternRemoval":
      walkWordParts(op.pattern.parts, c);
      break;
    case "PatternReplacement":
      walkWordParts(op.pattern.parts, c);
      if (op.replacement) walkWordParts(op.replacement.parts, c);
      break;
    case "CaseModification":
      if (op.pattern) walkWordParts(op.pattern.parts, c);
      break;
    case "Indirection":
      if (op.innerOp) walkParameterOp(op.innerOp, c);
      break;
  }
}
