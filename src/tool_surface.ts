// tool_surface — the package's public seam for the engine's FULL MCP tool surface.
//
// Governor ruling: there is no different thing. The hosted Coltrane MCP is the Coltrane
// MCP — the full tool surface, functioning against the Supabase store. A host imports this
// subpath (or "./genome_store" for the store port), builds per-request deps from the
// caller's bearer, and mounts createToolSurface() on whatever transport it serves. The
// stdio server consumes the same registry internally — one surface, two transports.
export {
  createToolSurface,
  dispatchTool,
  type SurfaceTool,
  type SurfaceToolResult,
  type ToolSurfaceDeps,
  type ServerDeps,
  type ToolResult,
} from "./server.js";
export { MCP_TOOLS, type MCPToolDef } from "./mcp.js";

// Host-side constructors — everything a hosted mount needs to build per-request deps
// without importing the package's main index (which drags process-local modules).
export { createRegistry, loadRegistry, type Registry } from "./registry.js";
export { createOutputStore } from "./outputs.js";
export { MemoryLedger } from "./ledger.js";
