import { toJSONSchema } from "zod";
import { writeFileSync } from "fs";
import { ConfigSchema } from "../src/config";

const schema = toJSONSchema(ConfigSchema);

writeFileSync("schema.json", JSON.stringify(schema, null, 2) + "\n");
console.log("Generated schema.json");
