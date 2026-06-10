export default function run(input) {
  return { count: Array.isArray(input.tokens) ? input.tokens.length : 0 };
}
