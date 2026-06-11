// An EQUIVALENT rewrite of number-adder's code half — different shape, same outputs.
// The evolution gate must ACCEPT it: every fixture still passes.
export default function run(input) {
  return { sum: [input.a, input.b].reduce((x, y) => x + y, 0) };
}
