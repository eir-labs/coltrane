#!/usr/bin/env node
// The Node floor, checked at INSTALL (package.json "preinstall"). CommonJS and dependency-free
// on purpose: it must run on any Node old enough to be refused, before anything is built.
// `engines` alone is advisory — npm warns and installs anyway — so this is what makes the
// install itself refuse. Node < 25 has no --allow-net, and 25 is end-of-life, so a skill's network grant cannot be
// enforced there: no degraded mode, no backwards compatibility (the sovereign, 26 Sep 2026).
const FLOOR = 26;
const major = Number(process.versions.node.split(".")[0]);
if (major < FLOOR) {
  process.stderr.write(
    `@eir-labs/coltrane requires Node ${FLOOR} or newer; this is Node ${process.versions.node}.\n` +
    `A skill's network grant is enforced by --allow-net, which Node 24 and older do not have (it arrived in 25, now end-of-life).\n` +
    `Install it (e.g. \`nvm install ${FLOOR}\`) and retry.\n`);
  process.exit(1);
}
