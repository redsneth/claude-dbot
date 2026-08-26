import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config, loadProjects } from "./config.js";
import { defaultCooldownUntil, runClaude } from "./claude.js";
import {
  getChannelProject,
  getDecryptedToken,
  getSession,
  getUserNotes,
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
  /** Recent channel messages, oldest first: send timestamp + formatted "Author: text" line. */
  history: { ts: number; line: string }[];
  /** When the invocation was a Discord reply: the replied-to message and its surroundings. */
  replyContext?: { target: string; around: string[] };
  /** Explicit project override (else channel default, else global default). */
  project?: string;
  /** Model key (haiku|sonnet|opus|fable); else the host's configured default. */
  model?: string;
  /** Which subscriptions to route to: own first + donated fallback (auto), own only, or donated only. */
  sub?: SubPreference;
  /** Whether the invoking channel is visible to @everyone (public-only shares require this). */
  isPublicChannel?: boolean;
  /** Standing note about allowlisted peer bots and how to address them. */
  peerNote?: string;
  /** Channel-mode style directive (e.g. chat mode's brevity rules), injected per question. */
  styleNote?: string;
}

export interface AskOutcome {
  ok: boolean;
  text: string;
  /** Present when a donated (not own) token answered. */
  viaDonor?: string;
}

function resolveProject(channelId: string, override?: string): { name: string; cwd: string; hasProject: boolean } {
  const projects = loadProjects();
  const name = override ?? getChannelProject(channelId) ?? projects.default;
  // "none" opts a channel out of the global default project (general chat mode).
  if (name && name !== "none" && projects.projects[name]) {
    return { name, cwd: projects.projects[name].path, hasProject: true };
  }
  const scratch = join(config.dataDir, "scratch");
  mkdirSync(scratch, { recursive: true });
  return { name: "none", cwd: scratch, hasProject: false };
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
  const isPublic = req.isPublicChannel ?? false;
  const candidates = applySubPreference(candidatesFor(req.userId, model, isPublic), pref);
  if (candidates.length === 0) {
    const reset = earliestReset(req.userId, isPublic);
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
    const privateHint = !isPublic
      ? " Note: this channel isn't visible to everyone, so donors who share **public channels only** don't apply here."
      : "";
    return {
      ok: false,
      text:
        `No subscription available to you allows **${MODELS[model].label}** right now.${when}${privateHint}\n` +
        `Register your own with **/register** (run \`claude setup-token\` in a terminal to get a token), ` +
        `ask a friend to **/share** theirs, or try a smaller model via the \`model\` option on /ask.`,
    };
  }

  const { name: project, cwd, hasProject } = resolveProject(req.channelId, req.project);
  const session = getSession(req.channelId, project);
  const existingSession = session?.sessionId;

  // The session already has whatever the bot saw during its own invocations; on resume,
  // include only channel messages newer than its last reply so nothing said in between is lost.
  const visibleHistory = existingSession
    ? req.history.filter((h) => h.ts > session.updatedAt)
    : req.history;
  const historyBlock = visibleHistory.length
    ? `${existingSession ? "Channel messages since your last reply" : "Recent channel messages for context"}:\n` +
      `<discord_history>\n${visibleHistory.map((h) => h.line).join("\n")}\n</discord_history>\n\n`
    : "";
  const notes = getUserNotes(req.userId);
  const notesBlock = notes.length
    ? `Self-reported facts about ${req.userName} (they entered these via /remember):\n${notes.map((n) => `- ${n}`).join("\n")}\n\n`
    : "";
  // Reply context is question-specific, so it's included even when resuming a session.
  const replyBlock = req.replyContext
    ? `${req.userName} is REPLYING TO this specific message — it is the referent of their question:\n` +
      `>>> ${req.replyContext.target}\n` +
      (req.replyContext.around.length
        ? `Conversation around that message (oldest first):\n<reply_context>\n${req.replyContext.around.join("\n")}\n</reply_context>\n`
        : "") +
      `\n`
    : "";
  const peerBlock = req.peerNote ? `${req.peerNote}\n\n` : "";
  const styleBlock = req.styleNote ? `${req.styleNote}\n\n` : "";
  const prompt = `${historyBlock}${replyBlock}${peerBlock}${notesBlock}${styleBlock}${req.userName} asks: ${req.question}`;

  const failures: string[] = [];
  for (const candidate of candidates) {
    const token = getDecryptedToken(candidate.ownerId);
    if (!token) continue;

    const result = await runClaude({
      prompt,
      cwd,
      hasProject,
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

  const reset = earliestReset(req.userId, isPublic);
  const when = reset ? ` Try again around <t:${Math.floor(reset / 1000)}:t>.` : "";
  return {
    ok: false,
    text: `All subscriptions available to you are rate-limited (${failures.length} tried).${when}`,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
