// The Node floor, checked when a coltrane process STARTS. Imported FIRST by every entry point
// (cli_entry, server_entry) so it runs before anything else loads. It is NOT imported by any
// library entry (tool_surface, genome_store, the main entry): the founder ruling of 26 Sep 2026
// put the floor where skills run, so the package installs and imports on Node 24, and the bins —
// `coltrane work` drains gigs whose chairs run skills, `coltrane-server` serves skill_execute —
// refuse here. Node < 25 cannot back a network grant (no --allow-net), and 25 is end-of-life, so a
// coltrane process refuses to start there at all — no degraded mode (the sovereign, 26 Sep 2026).
export const NODE_FLOOR = 26;

export function belowFloor(version: string = process.versions.node): boolean {
  return Number(version.split(".")[0]) < NODE_FLOOR;
}

if (belowFloor()) {
  process.stderr.write(
    `coltrane requires Node ${NODE_FLOOR} or newer; this is Node ${process.versions.node}. ` +
      `A skill's network controls (its network grant, enforced by --allow-net) do not exist in Node 24 and older (--allow-net arrived in 25, now end-of-life).\n`,
  );
  process.exit(1);
}
