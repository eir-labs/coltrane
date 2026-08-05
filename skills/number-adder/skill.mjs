// number-adder — the execution half. Pure: input in, output out, no I/O, no LLM.
// determinism_ratio 1.0 (the code resolves the entire output; the residual is empty).
//
// `source` is the skill's own identity. A skill-backed chair seals the skill's return value
// verbatim, so when that chair is Signal-cored the skill is the only thing that can answer
// "where did this come from" — and the #227 ruling makes that answer mandatory on every
// Signal, bare or subtyped. It is a constant, so the skill stays pure and every field still
// originates in code (determinism_ratio 1.0 is unchanged).
export default function run(input) {
  const { a, b } = input;
  return { sum: a + b, source: "skill://number-adder@1" };
}
