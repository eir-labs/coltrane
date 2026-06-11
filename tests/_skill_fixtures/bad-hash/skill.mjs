// The on-disk code whose sha256 does NOT match meta.code_hash. Because the hash is
// unverified, the loader must NOT execute this — it degrades to pure-reasoning mode.
export default function run(input) {
  return { echo: String(input && input.text) };
}
