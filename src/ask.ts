import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config, loadProjects } from "./config.js";
import { defaultCooldownUntil, runClaude } from "./claude.js";
import {
  getChannelProject,
  getDecryptedToken,
  getSession,
  logUsage,
  setCooldown,
  setSession,
  setTokenStatus,
  touchToken,
} from "./db.js";
import { isModelKey, ModelKey, MODELS } from "./models.js";
import { applySubPreference, candidatesFor, earliestReset, SubPreference } from "./router.js";

export interface AskRequest {
  userId: string;
  userName: string;
  channelId: string;
  question: string;
  /** Recent channel messages, oldest first, already formatted as "Author: text" lines. */
  history: string[];
  /** Explicit project override (else channel default, else global default). */
  project?: string;
  /** Model key (haiku|sonnet|opus|fable); else the host's configured default. */
  model?: string;
  /** Which subscriptions to route to: own first + donated fallback (auto), own only, or donated only. */
  sub?: SubPreference;
}

export interface AskOutcome {
  ok: boolean;
  text: string;
  /** Present when a donated (not own) token answered. */
  viaDonor?: string;
}

function resolveProject(channelId: string, override?: string): { name: string; cwd: string } {
  const projects = loadProjects();
  const name = override ?? getChannelProject(channelId) ?? projects.default;
  if (name && projects.projects[name]) {
    return { name, cwd: projects.projects[name].path };
  }
  const scratch = join(config.dataDir, "scratch");
  mkdirSync(scratch, { recursive: true });
  return { name: "scratch", cwd: scratch };
}

// One Claude run per channel at a time, so session resumes don't race.
const channelQueues = new Map<string, Promise<unknown>>();

export function enqueue<T>(channelId: string, job: () => Promise<T>): Promise<T> {
  const tail = channelQueues.get(channelId) ?? Promise.resolve();
  const next = tail.then(job, job);
  channelQueues.set(channelId, next.catch(() => {}));
  return next;
}

function resolveModel(override?: string): ModelKey {
  if (override && isModelKey(override)) return override;
  if (isModelKey(config.defaultModel)) return config.defaultModel;
  return "sonnet";
}

export async function ask(req: AskRequest): Promise<AskOutcome> {
  const model = resolveModel(req.model);
  const pref: SubPreference = req.sub ?? "auto";
  const candidates = applySubPreference(candidatesFor(req.userId, model), pref);
  if (candidates.length === 0) {
    const reset = earliestReset(req.userId);
    const when = reset ? ` Rate limits reset around <t:${Math.floor(reset / 1000)}:t>.` : "";
    if (pref === "mine") {
      return {
        ok: false,
        text:
          `You asked for your own subscription only, but it isn't usable right now ` +
          `(not registered, or rate-limited).${when} Register with **/setup**, or drop the \`sub\` option to allow donated subs.`,
      };
    }
    if (pref === "donated") {
      return {
        ok: false,
        text: `No donated subscription available to you allows **${MODELS[model].label}** right now.${when}`,
      };
    }
    return {
      ok: false,
      text:
        `No subscription available to you allows **${MODELS[model].label}** right now.${when}\n` +
        `Register your own with **/register** (run \`claude setup-token\` in a terminal to get a token), ` +
        `ask a friend to **/share** theirs, or try a smaller model via the \`model\` option on /ask.`,
    };
  }

  const { name: project, cwd } = resolveProject(req.channelId, req.project);
  const existingSession = getSession(req.channelId, project);

  // When resuming, the session already has the conversation; only new context is needed.
  const historyBlock =
    !existingSession && req.history.length
      ? `Recent channel messages for context:\n<discord_history>\n${req.history.join("\n")}\n</discord_history>\n\n`
      : "";
  const prompt = `${historyBlock}${req.userName} asks: ${req.question}`;

  const failures: string[] = [];
  for (const candidate of candidates) {
    const token = getDecryptedToken(candidate.ownerId);
    if (!token) continue;

    const result = await runClaude({
      prompt,
      cwd,
      oauthToken: token,
      model: MODELS[model].id,
      resumeSessionId: existingSession,
    });

    if (result.sessionId) setSession(req.channelId, project, result.sessionId);
    if (result.windowInfo) {
      setTokenStatus(candidate.ownerId, result.windowInfo.utilization, result.windowInfo.limitType);
    }
    if (result.usage) {
      logUsage({
        ownerId: candidate.ownerId,
        requesterId: req.userId,
        model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.usage.costUsd,
      });
    }

    if (result.ok) {
      touchToken(candidate.ownerId);
      return {
        ok: true,
        text: result.text,
        viaDonor: candidate.isOwn ? undefined : candidate.ownerId,
      };
    }

    if (result.rateLimited) {
      const until = result.rateLimited.resetsAtMs ?? defaultCooldownUntil();
      setCooldown(candidate.ownerId, until, "rate limit");
      failures.push(`<@${candidate.ownerId}>'s sub is rate-limited`);
      continue; // fail over to the next token
    }

    // Non-rate-limit error: retrying with another sub won't help.
    return { ok: false, text: `Something went wrong: ${truncate(result.text, 500)}` };
  }

  const reset = earliestReset(req.userId);
  const when = reset ? ` Try again around <t:${Math.floor(reset / 1000)}:t>.` : "";
  return {
    ok: false,
    text: `All subscriptions available to you are rate-limited (${failures.length} tried).${when}`,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
