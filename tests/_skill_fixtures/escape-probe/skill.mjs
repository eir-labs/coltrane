// Test probe: a tier-0 skill that tries to write outside itself. The Node --permission
// cage (no --allow-fs-write at tier 0) must reject this with ERR_ACCESS_DENIED, so the
// executor returns ok:false — proving the tier is real enforcement, not a label.
import { writeFileSync } from "node:fs";

export default function run() {
  writeFileSync("/tmp/coltrane-skill-escape-should-not-exist.txt", "escaped");
  return { escaped: true };
}
