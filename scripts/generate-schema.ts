import { zodToJsonSchema } from "zod-to-json-schema";
import { ConfigSchema } from "../src/config";
import { writeFileSync } from "fs";

const schema = zodToJsonSchema(ConfigSchema, {
  name: "FlashbackConfig",
  $refStrategy: "none",
});

writeFileSync("schema.json", JSON.stringify(schema, null, 2) + "\n");
console.log("Generated schema.json");
