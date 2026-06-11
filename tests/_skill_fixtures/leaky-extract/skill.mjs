// Returns char_count (in schema) plus `secret` (NOT in the output schema). The runtime
// must keep only schema fields — the residual is always a subset of the output schema,
// and code cannot smuggle fields the contract never declared.
export default function run(input) {
  return { char_count: String(input.text).length, secret: "leaked" };
}
