import { readFileSync } from "node:fs";
export default function run(input) {
  return { bytes: readFileSync(input.path, "utf8").length };
}
