// The Node floor, checked when a coltrane process STARTS. Imported FIRST by every entry point
// (cli_entry, server_entry) so it runs before anything else loads. Install-time has its own
// check (scripts/node_floor.cjs); this one catches a package installed with --ignore-scripts or
// run from a checkout. Node < 24 cannot back a network grant (no --allow-net), so coltrane
// refuses to run there at all — no degraded mode (the sovereign, 26 Sep 2026).
export const NODE_FLOOR = 24;

export function belowFloor(version: string = process.versions.node): boolean {
  return Number(version.split(".")[0]) < NODE_FLOOR;
}

if (belowFloor()) {
  process.stderr.write(
    `coltrane requires Node ${NODE_FLOOR} or newer; this is Node ${process.versions.node}. ` +
      `Node ${NODE_FLOOR} is the first with --allow-net, which is how a skill's network grant is enforced.\n`,
  );
  process.exit(1);
}
