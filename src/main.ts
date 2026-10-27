#!/usr/bin/env -S node --import tsx
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { SessionManager } from "./session.js";

const session = new SessionManager();
await session.start();
const server = createMcpServer(session);
const transport = new StdioServerTransport();
transport.onclose = () => session.stop();
await server.connect(transport);
