#!/usr/bin/env node
/**
 * freeitsm-mcp-server entry point: serves MCP over stdio.
 * Everything else lives in server.ts, so this file has no import-time checks.
 * Logs go to stderr; stdout carries the protocol.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { bootstrap, createServerFactory, VERSION } from "./server.js";

try {
  const deps = await bootstrap();
  const { access, catalogue, config } = deps;
  for (const warning of [...config.warnings, ...catalogue.warnings]) console.error(`freeitsm-mcp-server: warning: ${warning}`);
  const usable = catalogue.endpoints.filter((e) => access.allows(e)).length;
  serveStdio(createServerFactory(deps));
  console.error(
    `freeitsm-mcp-server ${VERSION}: key "${access.key.name}" as ${access.key.actsAs ?? "?"}, ` +
      `${usable}/${catalogue.endpoints.length} endpoints usable, ${access.readOnly ? "READ-ONLY" : "WRITABLE"}, ` +
      `local-file uploads ${config.uploadDir ? `from ${config.uploadDir}` : "off"}`,
  );
} catch (e) {
  console.error(`freeitsm-mcp-server: ${(e as Error).message}`);
  process.exit(1);
}
