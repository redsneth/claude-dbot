import {
  ActionRowBuilder,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  MessageFlags,
  PermissionFlagsBits,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { config, loadProjects } from "./config.js";
import { ask, enqueue } from "./ask.js";
import { chunkMessage } from "./format.js";
import {
  addShare,
  addUserNote,
  clearChannelProject,
  clearSessions,
  clearUserNotes,
  deleteToken,
  getUserNotes,
  getChannelProject,
  getCooldown,
  getMaxTier,
  getTokenStatus,
  hasToken,
  listSharesByOwner,
  removeShare,
  setChannelProject,
  setMaxTier,
  setToken,
  usageSummary,
} from "./db.js";
import { isModelKey, MODELS } from "./models.js";
import { candidatesFor } from "./router.js";
import * as wizard from "./wizard.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  // Default for every send: ping nobody except allowlisted peer bots (and reply targets).
  allowedMentions: { parse: [], users: config.peerBots, repliedUser: true },
});

const HISTORY_LIMIT = 30;

/**
 * A channel counts as "public" when the @everyone role can view it (threads
 * inherit from their parent). DMs and unresolvable channels count as private.
 */
function isPublicChannel(channel: unknown): boolean {
  const ch = channel as {
    isThread?: () => boolean;
    parent?: unknown;
    guild?: { roles: { everyone: unknown } };
    permissionsFor?: (role: unknown) => { has: (p: bigint) => boolean } | null;
  } | null;
  if (!ch?.guild) return false;
  if (typeof ch.isThread === "function" && ch.isThread()) return isPublicChannel(ch.parent);
  if (typeof ch.permissionsFor !== "function") return false;
  return ch.permissionsFor(ch.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) ?? false;
}

function formatMsg(m: Message): string {
  return `${m.member?.displayName ?? m.author.displayName ?? m.author.username}: ${m.cleanContent}`;
}

async function fetchHistory(
  message: Message | null,
  channelId: string,
  excludeIds?: Set<string>,
): Promise<{ ts: number; line: string }[]> {
  const channel = message?.channel ?? (await client.channels.fetch(channelId));
  if (!channel || !("messages" in channel)) return [];
  const fetched = await channel.messages.fetch({ limit: HISTORY_LIMIT });
  return [...fetched.values()]
    .reverse()
    .filter((m) => m.content.trim().length > 0 && !excludeIds?.has(m.id))
    .map((m) => ({ ts: m.createdTimestamp, line: formatMsg(m) }));
}

/**
 * When the invoking message is a Discord reply, resolve the replied-to message
 * plus ~5 messages either side of it, so "why is he wrong?" has a referent.
 */
async function getReplyContext(
  message: Message,
): Promise<{ target: string; around: string[]; ids: Set<string> } | undefined> {
  if (!message.reference?.messageId) return undefined;
  try {
    const target = await message.fetchReference();
    const around = await message.channel.messages.fetch({ around: target.id, limit: 11 });
    const sorted = [...around.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .filter((m) => m.content.trim().length > 0 && m.id !== message.id);
    return { target: formatMsg(target), around: sorted.map(formatMsg), ids: new Set(around.keys()) };
  } catch (err) {
    console.error("Could not fetch reply context:", err);
    return undefined;
  }
}

async function handleAsk(interaction: ChatInputCommandInteraction): Promise<void> {
  const question = interaction.options.getString("question", true);
  const project = interaction.options.getString("project") ?? undefined;
  const model = interaction.options.getString("model") ?? undefined;
  const sub = (interaction.options.getString("sub") ?? undefined) as "auto" | "mine" | "donated" | undefined;

  const askerName =
    interaction.member && "displayName" in interaction.member
      ? interaction.member.displayName
      : interaction.user.username;

  await interaction.deferReply();
  const history = await fetchHistory(null, interaction.channelId).catch(() => []);
  const outcome = await enqueue(interaction.channelId, () =>
    ask({
      userId: interaction.user.id,
      userName: askerName,
      channelId: interaction.channelId,
      question,
      history,
      project,
      model,
      sub,
      isPublicChannel: isPublicChannel(interaction.channel),
      peerNote,
    }),
  );

  const suffix = outcome.viaDonor ? `\n-# answered via <@${outcome.viaDonor}>'s subscription` : "";
  const chunks = chunkMessage(`**Q (${askerName}):** ${question}\n\n${linkifyPeers(outcome.text)}${suffix}`);
  await interaction.editReply(chunks[0] ?? "(empty response)");
  for (const chunk of chunks.slice(1)) await interaction.followUp(chunk);
}

function registerModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("register-token")
    .setTitle("Register Claude subscription token")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("token")
          .setLabel("Token from `claude setup-token`")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("sk-ant-oat01-…")
          .setRequired(true),
      ),
    );
}

async function handleRegisterSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const token = interaction.fields.getTextInputValue("token").trim();
  if (token.length < 20 || /\s/.test(token)) {
    await interaction.reply({
      content: "That doesn't look like a token. Run `claude setup-token` in a terminal and paste the full output string.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  setToken(interaction.user.id, token);
  await interaction.reply({
    content:
      "Token stored (encrypted at rest). It is **private to you** until you run **/share**.\n" +
      "Heads up: the bot host machine can technically access stored tokens — only register if you trust the host.",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  switch (interaction.commandName) {
    case "ask":
      return handleAsk(interaction);

    case "setup":
      return wizard.startSetup(interaction);

    case "register":
      return void (await interaction.showModal(registerModal()));

    case "unregister": {
      deleteToken(interaction.user.id);
      return void (await interaction.reply({
        content: "Your token and all shares of it are deleted.",
        flags: MessageFlags.Ephemeral,
      }));
    }

    case "share": {
      if (!hasToken(interaction.user.id)) {
        return void (await interaction.reply({
          content: "You have no registered token to share. Use **/register** first.",
          flags: MessageFlags.Ephemeral,
        }));
      }
      const user = interaction.options.getUser("user");
      const publicOnly = interaction.options.getBoolean("public_only") ?? false;
      addShare(interaction.user.id, user ? user.id : "*", publicOnly);
      const scope = publicOnly ? " (usable in **public channels only**)" : "";
      return void (await interaction.reply(
        user
          ? `${interaction.user.displayName} shared their Claude sub with ${user}${scope}. Revoke anytime with /unshare.`
          : `${interaction.user.displayName} shared their Claude sub with **everyone** here${scope}. Revoke anytime with /unshare.`,
      ));
    }

    case "unshare": {
      const user = interaction.options.getUser("user");
      removeShare(interaction.user.id, user ? user.id : "*");
      return void (await interaction.reply({
        content: user ? `Share for ${user.username} revoked.` : "The 'everyone' share is revoked.",
        flags: MessageFlags.Ephemeral,
      }));
    }

    case "status": {
      const uid = interaction.user.id;
      const lines: string[] = [];
      if (hasToken(uid)) {
        const cd = getCooldown(uid);
        lines.push(
          cd
            ? `Your token: registered, **rate-limited** until <t:${Math.floor(cd.until / 1000)}:t>`
            : "Your token: registered and ready",
        );
        const ts = getTokenStatus(uid);
        if (ts?.utilization != null) {
          lines.push(
            `Your sub's ${ts.limitType?.replace(/_/g, "-") ?? "current"} window: ~${Math.round(ts.utilization)}% used ` +
              `(as of <t:${Math.floor(ts.updatedAt / 1000)}:R>)`,
          );
        }
        const tier = getMaxTier(uid);
        lines.push(
          tier === "any" || !isModelKey(tier)
            ? "Your share policy: others may use any model (change with /policy)"
            : `Your share policy: others capped at **${MODELS[tier].label}**`,
        );
        const shares = listSharesByOwner(uid);
        if (shares.length)
          lines.push(
            `You share with: ${shares
              .map((s) => (s.grantee === "*" ? "everyone" : `<@${s.grantee}>`) + (s.publicOnly ? " (public channels only)" : ""))
              .join(", ")}`,
          );
      } else {
        lines.push("Your token: none (use /register)");
      }
      const donors = candidatesFor(uid, undefined, isPublicChannel(interaction.channel)).filter((c) => !c.isOwn);
      lines.push(
        donors.length
          ? `Usable donated subs: ${donors.map((d) => `<@${d.ownerId}>`).join(", ")}`
          : "Usable donated subs: none",
      );
      const project = getChannelProject(interaction.channelId) ?? loadProjects().default ?? "none";
      lines.push(`This channel's project: **${project === "none" ? "none (general chat)" : project}**`);
      const noteCount = getUserNotes(uid).length;
      if (noteCount) lines.push(`The bot remembers ${noteCount} thing${noteCount === 1 ? "" : "s"} about you (/remember to review, /forget to wipe)`);
      return void (await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral }));
    }

    case "policy": {
      if (!hasToken(interaction.user.id)) {
        return void (await interaction.reply({
          content: "You have no registered token. Use **/register** first.",
          flags: MessageFlags.Ephemeral,
        }));
      }
      const maxModel = interaction.options.getString("max_model", true);
      setMaxTier(interaction.user.id, maxModel);
      return void (await interaction.reply({
        content:
          maxModel === "any"
            ? "Others may now use **any model** on your subscription."
            : `Others are now capped at **${isModelKey(maxModel) ? MODELS[maxModel].label : maxModel}** on your subscription. Your own asks are never capped.`,
        flags: MessageFlags.Ephemeral,
      }));
    }

    case "usage": {
      if (!hasToken(interaction.user.id)) {
        return void (await interaction.reply({
          content: "You have no registered token, so there is nothing to report.",
          flags: MessageFlags.Ephemeral,
        }));
      }
      const days = interaction.options.getInteger("days") ?? 7;
      const s = usageSummary(interaction.user.id, Date.now() - days * 86400e3);
      const fmt = (n: number) => n.toLocaleString("en-US");
      const lines = [
        `**Your subscription's usage through this bot, last ${days}d:**`,
        `${s.runs} runs · ${fmt(s.inputTokens)} input + ${fmt(s.outputTokens)} output tokens · ~$${s.costUsd.toFixed(2)} API-equivalent`,
      ];
      if (s.byModel.length)
        lines.push(`By model: ${s.byModel.map((m) => `${m.model} ×${m.runs} (~$${m.costUsd.toFixed(2)})`).join(", ")}`);
      if (s.byRequester.length)
        lines.push(
          `By user: ${s.byRequester.map((r) => `<@${r.requesterId}> ×${r.runs} (~$${r.costUsd.toFixed(2)})`).join(", ")}`,
        );
      const ts = getTokenStatus(interaction.user.id);
      if (ts?.utilization != null)
        lines.push(
          `Current ${ts.limitType?.replace(/_/g, "-") ?? ""} window: ~${Math.round(ts.utilization)}% used (as of <t:${Math.floor(ts.updatedAt / 1000)}:R>)`,
        );
      lines.push(
        `-# Dollar figures are the SDK's API-price estimate — a gauge of relative quota burn, not a bill; your sub is flat-rate.`,
      );
      return void (await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral }));
    }

    case "project": {
      const sub = interaction.options.getSubcommand();
      const projects = loadProjects();
      if (sub === "list") {
        const entries = Object.entries(projects.projects);
        const body = entries.length
          ? entries
              .map(([name, p]) => `- **${name}**${name === projects.default ? " (default)" : ""} — ${p.description ?? p.path}`)
              .join("\n") +
            "\n- **none** — no project; general chat mode (good for offtopic channels)"
          : "No projects configured. The host adds them in `projects.json`.";
        return void (await interaction.reply({ content: body, flags: MessageFlags.Ephemeral }));
      }
      if (sub === "clear") {
        clearChannelProject(interaction.channelId);
        return void (await interaction.reply({ content: "Channel project default cleared.", flags: MessageFlags.Ephemeral }));
      }
      const name = interaction.options.getString("name", true);
      if (name !== "none" && !projects.projects[name]) {
        return void (await interaction.reply({
          content: `Unknown project \`${name}\`. See **/project list** (tip: \`none\` = general chat mode).`,
          flags: MessageFlags.Ephemeral,
        }));
      }
      setChannelProject(interaction.channelId, name);
      return void (await interaction.reply(
        name === "none"
          ? "This channel is now **project-free** — Claude acts as a general assistant here, no codebase assumed."
          : `This channel now defaults to project **${name}**.`,
      ));
    }

    case "reset": {
      clearSessions(interaction.channelId);
      return void (await interaction.reply("Fresh start — Claude's conversation memory for this channel is cleared."));
    }

    case "remember": {
      const note = interaction.options.getString("note", true).replace(/\s+/g, " ").trim();
      if (!note) {
        return void (await interaction.reply({ content: "Empty note — nothing stored.", flags: MessageFlags.Ephemeral }));
      }
      addUserNote(interaction.user.id, note);
      const notes = getUserNotes(interaction.user.id);
      return void (await interaction.reply({
        content:
          `Noted. I now remember ${notes.length}/10 things about you:\n` +
          notes.map((n) => `- ${n}`).join("\n") +
          "\n-# these apply to your future questions everywhere on the server · /forget wipes them",
        flags: MessageFlags.Ephemeral,
      }));
    }

    case "forget": {
      clearUserNotes(interaction.user.id);
      return void (await interaction.reply({
        content: "Wiped — the bot remembers nothing about you now.",
        flags: MessageFlags.Ephemeral,
      }));
    }
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) await handleCommand(interaction);
    else if (interaction.isButton() && interaction.customId.startsWith("wiz:")) await wizard.handleButton(interaction);
    else if (interaction.isStringSelectMenu() && interaction.customId.startsWith("wiz:"))
      await wizard.handleSelect(interaction);
    else if (interaction.isModalSubmit() && interaction.customId === "wiz:token-modal")
      await wizard.handleTokenModal(interaction);
    else if (interaction.isModalSubmit() && interaction.customId === "register-token")
      await handleRegisterSubmit(interaction);
  } catch (err) {
    console.error("Interaction failed:", err);
    if (interaction.isRepliable()) {
      const msg = { content: "Something broke handling that — check the bot logs.", flags: MessageFlags.Ephemeral } as const;
      await (interaction.deferred || interaction.replied
        ? interaction.followUp(msg)
        : interaction.reply(msg)
      ).catch(() => {});
    }
  }
});

// Peer-bot mention string -> display name, resolved at startup for the prompt note.
let peerNote: string | undefined;
const peerNames = new Map<string, string>(); // id -> display name

/**
 * The model sees mentions as readable "@Name" text (cleanContent) and mimics that
 * form back regardless of instructions — which Discord renders as dead text. So we
 * linkify: any "@PeerName" in an outgoing answer becomes a real <@id> mention.
 */
function linkifyPeers(text: string): string {
  let out = text;
  for (const [id, name] of peerNames) {
    const pattern = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    out = out.replace(pattern, `<@${id}>`);
  }
  return out;
}

// channelId -> consecutive bot-invoked answers; any human message resets it.
const botChain = new Map<string, number>();

// @mention invocation: "@bot why is the build failing?" — includes channel history as context.
// Allowlisted peer bots may also invoke (bot-to-bot discussions), bounded by maxBotChain.
client.on(Events.MessageCreate, async (message) => {
  if (!client.user || message.author.id === client.user.id) return;
  if (!message.author.bot) botChain.set(message.channelId, 0);

  const isPeerBot = message.author.bot && config.peerBots.includes(message.author.id);
  if (message.author.bot && !isPeerBot) return;
  // Raw-content check as well: mentions suppressed via allowedMentions may not
  // populate message.mentions, and peer bots ping each other with suppressed mentions.
  const mentioned =
    message.mentions.has(client.user) ||
    message.content.includes(`<@${client.user.id}>`) ||
    message.content.includes(`<@!${client.user.id}>`);
  if (!mentioned || message.mentions.everyone) return;

  if (isPeerBot) {
    const chain = (botChain.get(message.channelId) ?? 0) + 1;
    botChain.set(message.channelId, chain);
    if (chain > config.maxBotChain) {
      if (chain === config.maxBotChain + 1) {
        await message
          .reply({ content: "-# bot-to-bot chain limit reached — a human needs to say something to continue 🤖✋", allowedMentions: { parse: [] } })
          .catch(() => {});
      }
      return;
    }
  }

  const question = message.content
    .replaceAll(`<@${client.user.id}>`, "")
    .replaceAll(`<@!${client.user.id}>`, "")
    .trim();
  if (!question) return;

  try {
    if ("sendTyping" in message.channel) await message.channel.sendTyping();
    const replyContext = await getReplyContext(message);
    const history = await fetchHistory(message, message.channelId, replyContext?.ids);
    const outcome = await enqueue(message.channelId, () =>
      ask({
        userId: message.author.id,
        userName: message.member?.displayName ?? message.author.username,
        channelId: message.channelId,
        question,
        history: history.slice(0, -1), // drop the invoking message itself
        replyContext: replyContext && { target: replyContext.target, around: replyContext.around },
        isPublicChannel: isPublicChannel(message.channel),
        peerNote,
      }),
    );
    const suffix = outcome.viaDonor ? `\n-# answered via <@${outcome.viaDonor}>'s subscription` : "";
    const chunks = chunkMessage(linkifyPeers(outcome.text) + suffix);
    // Suppress all pings except allowlisted peer bots, so bot-to-bot mentions actually deliver.
    const mentionPolicy = { parse: [] as never[], users: config.peerBots };
    let last = await message.reply({ content: chunks[0] ?? "(empty response)", allowedMentions: { ...mentionPolicy, repliedUser: true } });
    for (const chunk of chunks.slice(1)) last = await last.reply({ content: chunk, allowedMentions: mentionPolicy });
  } catch (err) {
    console.error("Mention handling failed:", err);
    await message.reply("Something broke handling that — check the bot logs.").catch(() => {});
  }
});

client.once(Events.ClientReady, async (c) => {
  if (config.peerBots.length) {
    const entries: string[] = [];
    for (const id of config.peerBots) {
      const name = await c.users.fetch(id).then((u) => u.displayName).catch(() => "unknown bot");
      peerNames.set(id, name);
      entries.push(`<@${id}> (${name})`);
    }
    peerNote =
      `Other AI bots live on this server: ${entries.join(", ")}. When someone asks you to discuss with one, ` +
      `or one of them addresses you, you may talk to it: include its mention (e.g. ${entries[0]?.split(" ")[0]}) ` +
      `literally in your reply to hand it the floor. Keep bot-to-bot replies SHORT and substantive; ` +
      `don't mention a bot unless a discussion with it is actually wanted.`;
    console.log(`Peer bots configured: ${entries.join(", ")}`);
  }
  console.log(`Logged in as ${c.user.tag}. Invite URL:`);
  console.log(
    `https://discord.com/oauth2/authorize?client_id=${config.clientId}&scope=bot%20applications.commands&permissions=274877975552`,
  );
});

client.login(config.discordToken);
