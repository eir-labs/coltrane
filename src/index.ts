export * from "./version.js";
export * from "./core_types.js";
export * from "./type_versioning.js";
export * from "./composition.js";
export * from "./tool_providers.js";
export * from "./playwright_cage.js";
export * from "./mcp.js";
export * from "./pricing.js";
export * from "./access_grant.js";
export * from "./agent_profile.js";
export * from "./output_validation.js";
export * from "./simulate.js";
export * from "./coltrane_profile.js";
export * from "./learner.js";
export * from "./registry.js";
export * from "./loader.js";
export * from "./canonical_core_types.js";
export * from "./canonical_form.js";
export * from "./ledger.js";
export * from "./outputs.js";
export * from "./output_mirror.js";
export * from "./hosted_tools.js";
export * from "./genome_store.js";
export * from "./reuse.js";
export * from "./charter.js";
export * from "./server.js";
export * from "./runtime.js";
export * from "./gig_conformance.js";
export * from "./chart.js";
export * from "./claude_invoker.js";
export * from "./turn_loop.js";
export * from "./chat_completions_port.js";
export * from "./completions_invoker.js";
// THE SEAM A DEPLOYMENT MUST IMPLEMENT HAS TO BE IMPORTABLE BY ONE. `resolveSeatBacking` and
// friends were reachable from inside src/ — which satisfied the orphan ratchet and left the only
// audience that has to satisfy the interface unable to name it. Reachable-within and
// importable-from-outside are different properties; the ratchet only ever asked the first.
export * from "./reside_backing.js";
export * from "./reside.js";
export * from "./circle_of_fifths.js";
export * from "./modulation_path.js";
export * from "./tensor_read.js";
export * from "./jsong.js";
export * from "./tones.js";
export * from "./gig_song.js";
export * from "./overtones.js";
export * from "./polyphony.js";
export * from "./harmonic_validation.js";
export * from "./acoustics.js";
export * from "./document_factory.js";

// The two engine-half modules a downstream consumer imports directly. Neither is wired into a
// surface yet — enqueueing locally and claiming locally are each their own contract — but both are
// PUBLIC surfaces, not internals: local_queue is the third queue backing (the file sibling of
// fileGenomeStore), and residency is the enforcement half of `coltrane reside`. Exporting them here
// is what tests/exported_symbols_are_reachable.test.ts asks for when a mechanism has no in-src
// caller: "wire it or export it." Wiring is a separate act; reachability is not.
export * from "./local_queue.js";
export * from "./residency.js";

// The release-record compiler — reads, at each v* tag, the surface an integrator sees (MCP tools, CLI
// flags, worker env, domain-type versions, law counts) and reports what each release changed. A public
// entrypoint, exported here so the public-entrypoint rule can name it.
export * from "./releases.js";
