export default function run(input) {
  return { tokens: String(input.text).split(/\s+/).filter(Boolean) };
}
