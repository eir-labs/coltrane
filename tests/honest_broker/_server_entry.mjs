// Independent-re-measurement MCP entry. Bootstraps the genome at COLTRANE_GENOME
// then overrides the agent invoker with a deterministic shape so the secondary
// (subprocess) path produces the same structural output as the primary (in-process)
// path when fed the same gig. Without overriding invoke, the prod default spawns
// Claude CLI — non-deterministic, would defeat the comparison.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Find the src dir relative to this entry. This entry lives at
// tests/honest_broker/_server_entry.mjs; src is two levels up.
const srcRoot = resolve(__dirname, "..", "..", "src");

const { bootstrapServerDeps, createColtraneServer } = await import(`${srcRoot}/server.ts`);
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

// Deterministic invoker — mirrors the in-process fixture used by the spec.
// The shape (sensor → text, summarizer → gist) matches the on-disk standard
// "summarize" wired in standards/summarize.json.
function deterministicInvoke(ctx) {
  const slug = ctx.agent.slug;
  const gig_input = ctx.gig_input ?? {};
  const topic = typeof gig_input.topic === "string" ? gig_input.topic : "default";
  if (slug === "sensor") return { text: `note about ${topic}` };
  if (slug === "summarizer") return { gist: `summary of ${topic}` };
  // unknown agent — return a permissive shape; the schema validator will
  // surface the real mismatch and that will appear as a divergence honestly.
  return {};
}

const genomeRoot = process.env.COLTRANE_GENOME;
if (!genomeRoot) {
  console.error("COLTRANE_GENOME must be set to the genome root");
  process.exit(2);
}

const baseDeps = bootstrapServerDeps(genomeRoot);
const deps = { ...baseDeps, invoke: deterministicInvoke, model_version: "honest-broker-deterministic-v1" };
const server = createColtraneServer(deps);
await server.connect(new StdioServerTransport());
