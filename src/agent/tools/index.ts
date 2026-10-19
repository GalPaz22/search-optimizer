import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { RunContext } from "../context.js";
import { catalogTools } from "./catalog.js";
import { changeTools } from "./changes.js";
import { insightTools } from "./insight.js";
import { operationsTools } from "./operations.js";
import { reportTools } from "./report.js";

export const MCP_SERVER = "tenant-analytics";

/** Every tool the conversion agent can use, scoped to one store and one run. */
export function buildAgentServer(ctx: RunContext, only?: string[]) {
  const all = [...insightTools(ctx), ...catalogTools(ctx), ...operationsTools(ctx), ...changeTools(ctx), ...reportTools(ctx)];
  return createSdkMcpServer({
    name: MCP_SERVER,
    version: "2.0.0",
    tools: only ? all.filter(t => only.includes(t.name)) : all,
  });
}
