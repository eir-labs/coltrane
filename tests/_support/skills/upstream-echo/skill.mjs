// upstream-echo — the test skill for per-role upstream delivery. Pure.
// run(input, context): `input` is the legacy merge; `context.upstream` (when the runtime supplies it)
// is the list of upstream outputs, each {role, domain_type, data}.
export default function run(input, context) {
  const upstream = context && Array.isArray(context.upstream) ? context.upstream : [];
  return {
    merged_keys: Object.keys(input ?? {}).sort(),
    upstream_count: upstream.length,
    upstream_roles: upstream.map((u) => u.role).sort(),
    upstream_values: upstream.map((u) => u.data && u.data.value).sort(),
    source: "skill://upstream-echo@1",
  };
}
