#!/usr/bin/env node
// The Node floor, checked at INSTALL (package.json "preinstall"). CommonJS and dependency-free
// on purpose: it must run on any Node old enough to be refused, before anything is built.
// `engines` alone is advisory — npm warns and installs anyway — so this is what makes the
// install itself refuse. Node < 24 has no --allow-net, so a skill's network grant cannot be
// enforced there: no degraded mode, no backwards compatibility (the sovereign, 26 Sep 2026).
const FLOOR = 24;
const major = Number(process.versions.node.split(".")[0]);
if (major < FLOOR) {
  process.stderr.write(
    `@eir-labs/coltrane requires Node ${FLOOR} or newer; this is Node ${process.versions.node}.\n` +
    `Node ${FLOOR} is the first with --allow-net, which is how a skill's network grant is enforced.\n` +
    `Install it (e.g. \`nvm install ${FLOOR}\`) and retry.\n`);
  process.exit(1);
}
