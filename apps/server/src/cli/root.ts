import { Command } from "effect/unstable/cli";

import { authCommand } from "./auth.ts";
import { browserCommand } from "./browser.ts";
import { sharedServerCommandFlags } from "./config.ts";
import { projectCommand } from "./project.ts";
import { runServerCommand, serveCommand, startCommand } from "./server.ts";

export const cli = Command.make("salchi", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the Salchi server."),
  Command.withHandler((flags) => runServerCommand(flags)),
  Command.withSubcommands([
    startCommand,
    serveCommand,
    authCommand,
    projectCommand,
    browserCommand,
  ]),
);
