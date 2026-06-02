// quick smoke check: does the loader accept the new sub_thread_invocation standard?
import { loadGenome } from "../../src/loader.js";

const g = loadGenome(process.argv[2] ?? ".");
const s = g.standards.get("sub_thread_invocation");
if (!s) {
  console.error("FAIL: sub_thread_invocation standard not loaded");
  process.exit(1);
}
console.log(JSON.stringify({
  loaded: true,
  slug: s.slug,
  domain: s.domain,
  agents: s.agents.map((a) => a.slug),
  phases: s.phases.map((p) => ({ name: p.name, agent: p.agent })),
}, null, 2));
