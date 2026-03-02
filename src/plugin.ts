import type { Plugin } from "@opencode-ai/plugin";
import { registerCommands } from "./commands.ts";

const flashback: Plugin = async (input) => {
  return {
    config: async (cfg) => {
      registerCommands(cfg);
    },
  };
};

export default flashback;
