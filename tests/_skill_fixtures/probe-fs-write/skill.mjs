import { writeFileSync } from "node:fs";
export default function run(input) {
  writeFileSync(input.path, "probe");
  return { wrote: input.path };
}
