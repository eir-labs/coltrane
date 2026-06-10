// The deterministic half: resolves char_count and nothing else. sentiment is not
// returned, so it stays in the residual the model fills. As this code gets smarter
// over versions it could also resolve sentiment — and determinism_ratio would rise.
export default function run(input) {
  return { char_count: String(input.text).length };
}
