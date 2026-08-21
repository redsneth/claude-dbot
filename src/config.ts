import "dotenv/config";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  clientId: required("DISCORD_CLIENT_ID"),
  adminId: process.env.ADMIN_DISCORD_ID ?? "",
  dataDir: resolve(process.env.DBOT_DATA_DIR ?? "./data"),
  defaultCooldownMin: Number(process.env.DBOT_DEFAULT_COOLDOWN_MIN ?? 60),
  /** Guild ID for instant slash-command registration during development (optional). */
  devGuildId: process.env.DEV_GUILD_ID ?? "",
  /** Default model key (haiku|sonnet|opus|fable) when /ask doesn't specify one. */
  defaultModel: process.env.DBOT_DEFAULT_MODEL ?? "sonnet",
  /**
   * Which Claude Code filesystem settings load into runs. "project" (default) reads each
   * repo's CLAUDE.md/.claude only. A personal instance can set "user,project,local" to also
   * bring in the owner's global ~/.claude memory.
   */
  settingSources: (process.env.DBOT_SETTING_SOURCES ?? "project")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is "user" | "project" | "local" => ["user", "project", "local"].includes(s)),
};

mkdirSync(config.dataDir, { recursive: true });

export interface ProjectDef {
  path: string;
  description?: string;
}

export interface ProjectsConfig {
  default?: string;
  projects: Record<string, ProjectDef>;
}

export function loadProjects(): ProjectsConfig {
  const file = resolve("./projects.json");
  if (!existsSync(file)) return { projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ProjectsConfig;
    return { default: parsed.default, projects: parsed.projects ?? {} };
  } catch (err) {
    console.error("Could not parse projects.json:", err);
    return { projects: {} };
  }
}
