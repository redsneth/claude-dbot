// Diagnostic: does a bot-configured run actually see the plugin skills + persona?
// Usage: npx tsx scripts/diag.ts  (uses the admin's stored token; one tiny haiku call)
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../src/config.js";
import { getDecryptedToken } from "../src/db.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const token = getDecryptedToken(config.adminId);
if (!token) {
  console.error("No stored token for ADMIN_DISCORD_ID — register via /setup first.");
  process.exit(1);
}

const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
delete env.ANTHROPIC_API_KEY;
delete env.ANTHROPIC_AUTH_TOKEN;

const pluginPath = resolve("./bot-plugin");
console.log("plugin dir exists:", existsSync(resolve(pluginPath, ".claude-plugin/plugin.json")));
console.log("unslop file exists:", existsSync(resolve(pluginPath, "skills/unslop/SKILL.md")));

for await (const m of query({
  prompt: "Reply with one word: ok",
  options: {
    cwd: resolve(config.dataDir, "scratch"),
    env,
    maxTurns: 1,
    model: "claude-haiku-4-5",
    settingSources: config.settingSources,
  },
})) {
  const msg = m as Record<string, unknown> & { type: string; subtype?: string };
  if (msg.type === "system" && msg.subtype === "init") {
    console.log("INIT skills:", JSON.stringify(msg.skills ?? "MISSING"));
    console.log("INIT plugins:", JSON.stringify(msg.plugins ?? "MISSING"));
    const tools = msg.tools as string[] | undefined;
    console.log("INIT has Skill tool:", tools?.includes("Skill") ?? "unknown", `(${tools?.length} tools)`);
  }
  if (msg.type === "result") console.log("RESULT:", msg.subtype, "-", String(msg.result).slice(0, 80));
}
