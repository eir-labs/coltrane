// number-adder — the execution half. Pure: input in, output out, no I/O, no LLM.
// determinism_ratio 1.0 (the code resolves the entire output; the residual is empty).
export default function run(input) {
  const { a, b } = input;
  return { sum: a + b };
}
