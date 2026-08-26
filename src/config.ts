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
  /** Discord user IDs of other bots this bot will listen and reply to (bot-to-bot discussions). */
  peerBots: (process.env.DBOT_PEER_BOTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Max consecutive bot-invoked answers per channel before a human has to chime in. */
  maxBotChain: Number(process.env.DBOT_MAX_BOT_CHAIN ?? 4),
  /** Bot mode for channels with no explicit /botmode setting: off | chat | thread | free. */
  defaultBotMode: process.env.DBOT_DEFAULT_BOTMODE ?? "free",
  /** Ratio governor: look at the last N channel messages... */
  ratioWindow: Number(process.env.DBOT_RATIO_WINDOW ?? 10),
  /** ...and if more than this many are bot-authored, divert the answer to a thread. */
  ratioMaxBot: Number(process.env.DBOT_RATIO_MAX_BOT ?? 6),
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

/**
 * Host-editable personality file. Re-read on every ask, so edits apply
 * without a restart. Absent/empty file -> built-in default persona.
 */
export function loadPersona(): string | undefined {
  const file = resolve("./persona.md");
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8").trim();
  return text.length > 0 ? text : undefined;
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
