// THE ROOM REACHES ONLY ITS DOORS (wiki spec.coltrane.the-room-reaches-only-its-doors; Eugene: "Egress proxy, doors enforced").
//
// A room that declares doors.egress gets one `egress` service: this proxy, run as `node -e <source> -- <door…>` from the room's OWN pinned
// image (no new image, so no new digest). It joins room-net (internal) and one non-internal network, and admits a CONNECT only to a
// declared host on port 443. It terminates no TLS: it forwards the tunnel's bytes and never sees request content, so the seat's own TLS
// validation is what refuses a wrong address behind an admitted name. The host matching below is engine code, tested directly; the
// source the proxy runs is this function serialized, so the tested code is the running code (one home).

export const EGRESS_PROXY_PORT = 3128;

/** Admit a request line against the declared doors. Only `CONNECT <host>:443 HTTP/1.x`; the host is the PARSED authority, lowercased,
 *  with ONE trailing dot removed (DNS is case-insensitive, and a trailing dot is the same FQDN), then matched EXACTLY against the doors,
 *  normalised the same way. No suffix, prefix or pattern matching; no IP literal; no other port or method. SELF-CONTAINED: it is
 *  serialized into the proxy's source, so it references nothing outside itself. */
export function admitConnect(line: string, doors: readonly string[]): { ok: true; host: string; port: number } | { ok: false; why: string } {
  const m = /^CONNECT ([^\s]+) HTTP\/1\.[01]$/.exec(String(line).trim());
  if (!m) return { ok: false, why: "not a CONNECT request line" };
  const authority = m[1] as string;
  const colon = authority.lastIndexOf(":");
  if (colon <= 0) return { ok: false, why: "no port in the authority" };
  const rawHost = authority.slice(0, colon);
  const rawPort = authority.slice(colon + 1);
  if (!/^\d+$/.test(rawPort) || Number(rawPort) !== 443) return { ok: false, why: "port is not 443" };
  if (rawHost.startsWith("[") || /^[0-9.]+$/.test(rawHost)) return { ok: false, why: "an IP literal is not a door" };
  const norm = (h: string): string => { const l = h.toLowerCase(); return l.endsWith(".") ? l.slice(0, -1) : l; };
  const host = norm(rawHost);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) return { ok: false, why: "not a host name" };
  const admitted = doors.map(norm);
  if (!admitted.includes(host)) return { ok: false, why: "not a declared door" };
  return { ok: true, host, port: 443 };
}

/** The proxy the egress service runs: admitConnect serialized, then a CONNECT tunnel server on EGRESS_PROXY_PORT. The doors arrive as
 *  argv after "--". A refused request answers 403 and closes; nothing is forwarded for it. */
export function egressProxySource(): string {
  return [
    `const net = require("node:net");`,
    `const admitConnect = ${admitConnect.toString()};`,
    `const doors = process.argv.slice(process.argv.indexOf("--") + 1);`,
    `net.createServer((c) => {`,
    `  let buf = Buffer.alloc(0);`,
    `  const onData = (d) => {`,
    `    buf = Buffer.concat([buf, d]);`,
    `    const end = buf.indexOf("\\r\\n\\r\\n");`,
    `    if (end < 0) { if (buf.length > 8192) c.destroy(); return; }`,
    `    c.removeListener("data", onData);`,
    `    const line = buf.subarray(0, end).toString("latin1").split("\\r\\n")[0];`,
    `    const a = admitConnect(line, doors);`,
    `    if (!a.ok) { console.error("egress refused: " + a.why + ": " + JSON.stringify(line.slice(0, 200))); c.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n"); return; }`,
    `    const u = net.connect(a.port, a.host, () => { c.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n"); const rest = buf.subarray(end + 4); if (rest.length) u.write(rest); u.pipe(c); c.pipe(u); });`,
    `    u.on("error", () => c.destroy()); c.on("error", () => u.destroy());`,
    `  };`,
    `  c.on("data", onData);`,
    `}).listen(${EGRESS_PROXY_PORT}, "0.0.0.0");`,
  ].join("\n");
}
