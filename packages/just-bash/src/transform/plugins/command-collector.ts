import { collectCommands } from "../../interpreter/command-analysis.js";
import type {
  TransformContext,
  TransformPlugin,
  TransformResult,
} from "../types.js";

export interface CommandCollectorMetadata {
  commands: string[];
}

export class CommandCollectorPlugin
  implements TransformPlugin<CommandCollectorMetadata>
{
  readonly name = "command-collector";

  transform(
    context: TransformContext,
  ): TransformResult<CommandCollectorMetadata> {
    const { commands } = collectCommands(context.ast);
    return {
      ast: context.ast,
      metadata: { commands: [...commands].sort() },
    };
  }
}
