// An EQUIVALENT rewrite of number-adder's code half — different shape, same outputs.
// The evolution gate must ACCEPT it: every fixture still passes. "Same outputs" includes
// the `source` stamp the skill carries for the Signal floor (#227) — dropping it would be a
// behavioural change, and the gate would be right to reject it.
export default function run(input) {
  return { sum: [input.a, input.b].reduce((x, y) => x + y, 0), source: "skill://number-adder@1" };
}
