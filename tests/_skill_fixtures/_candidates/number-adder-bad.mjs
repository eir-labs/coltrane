// A REGRESSING rewrite: off by one. number-adder's basic fixture expects sum=8 for
// {a:3,b:5}; this returns 9. The evolution gate must REJECT it and name the fixture it
// broke — fixtures are the gate that keeps "improvements" from silently regressing.
export default function run(input) {
  return { sum: input.a + input.b + 1 };
}
