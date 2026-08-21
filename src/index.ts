import {
  ActionRowBuilder,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  MessageFlags,
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
  clearChannelProject,
  clearSessions,
  deleteToken,
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
});

const HISTORY_LIMIT = 30;

async function fetchHistory(message: Message | null, channelId: string): Promise<string[]> {
  const channel = message?.channel ?? (await client.channels.fetch(channelId));
  if (!channel || !("messages" in channel)) return [];
  const fetched = await channel.messages.fetch({ limit: HISTORY_LIMIT });
  return [...fetched.values()]
    .reverse()
    .filter((m) => m.content.trim().length > 0)
    .map((m) => `${m.member?.displayName ?? m.author.displayName ?? m.author.username}: ${m.cleanContent}`);
}

async function handleAsk(interaction: ChatInputCommandInteraction): Promise<void> {
  const question = interaction.options.getString("question", true);
  const project = interaction.options.getString("project") ?? undefined;
  const model = interaction.options.getString("model") ?? undefined;
  const sub = (interaction.options.getString("sub") ?? undefined) as "auto" | "mine" | "donated" | undefined;

  await interaction.deferReply();
  const outcome = await enqueue(interaction.channelId, () =>
    ask({
      userId: interaction.user.id,
      userName: interaction.member && "displayName" in interaction.member
        ? interaction.member.displayName
        : interaction.user.username,
      channelId: interaction.channelId,
      question,
      history: [],
      project,
      model,
      sub,
    }),
  );

  const suffix = outcome.viaDonor ? `\n-# answered via <@${outcome.viaDonor}>'s subscription` : "";
  const chunks = chunkMessage(`**Q (${interaction.user.displayName}):** ${question}\n\n${outcome.text}${suffix}`);
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
      addShare(interaction.user.id, user ? user.id : "*");
      return void (await interaction.reply(
        user
          ? `${interaction.user.displayName} shared their Claude sub with ${user}. Revoke anytime with /unshare.`
          : `${interaction.user.displayName} shared their Claude sub with **everyone** here. Revoke anytime with /unshare.`,
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
          lines.push(`You share with: ${shares.map((s) => (s === "*" ? "everyone" : `<@${s}>`)).join(", ")}`);
      } else {
        lines.push("Your token: none (use /register)");
      }
      const donors = candidatesFor(uid).filter((c) => !c.isOwn);
      lines.push(
        donors.length
          ? `Usable donated subs: ${donors.map((d) => `<@${d.ownerId}>`).join(", ")}`
          : "Usable donated subs: none",
      );
      const project = getChannelProject(interaction.channelId) ?? loadProjects().default ?? "scratch (none configured)";
      lines.push(`This channel's project: **${project}**`);
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
              .join("\n")
          : "No projects configured. The host adds them in `projects.json`.";
        return void (await interaction.reply({ content: body, flags: MessageFlags.Ephemeral }));
      }
      if (sub === "clear") {
        clearChannelProject(interaction.channelId);
        return void (await interaction.reply({ content: "Channel project default cleared.", flags: MessageFlags.Ephemeral }));
      }
      const name = interaction.options.getString("name", true);
      if (!projects.projects[name]) {
        return void (await interaction.reply({
          content: `Unknown project \`${name}\`. See **/project list**.`,
          flags: MessageFlags.Ephemeral,
        }));
      }
      setChannelProject(interaction.channelId, name);
      return void (await interaction.reply(`This channel now defaults to project **${name}**.`));
    }

    case "reset": {
      clearSessions(interaction.channelId);
      return void (await interaction.reply("Fresh start — Claude's conversation memory for this channel is cleared."));
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

// @mention invocation: "@bot why is the build failing?" — includes channel history as context.
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !client.user || !message.mentions.has(client.user)) return;
  if (message.mentions.everyone) return;

  const question = message.content.replaceAll(`<@${client.user.id}>`, "").trim();
  if (!question) return;

  try {
    if ("sendTyping" in message.channel) await message.channel.sendTyping();
    const history = await fetchHistory(message, message.channelId);
    const outcome = await enqueue(message.channelId, () =>
      ask({
        userId: message.author.id,
        userName: message.member?.displayName ?? message.author.username,
        channelId: message.channelId,
        question,
        history: history.slice(0, -1), // drop the invoking message itself
      }),
    );
    const suffix = outcome.viaDonor ? `\n-# answered via <@${outcome.viaDonor}>'s subscription` : "";
    const chunks = chunkMessage(outcome.text + suffix);
    let last = await message.reply({ content: chunks[0] ?? "(empty response)", allowedMentions: { repliedUser: true, parse: [] } });
    for (const chunk of chunks.slice(1)) last = await last.reply({ content: chunk, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error("Mention handling failed:", err);
    await message.reply("Something broke handling that — check the bot logs.").catch(() => {});
  }
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}. Invite URL:`);
  console.log(
    `https://discord.com/oauth2/authorize?client_id=${config.clientId}&scope=bot%20applications.commands&permissions=274877975552`,
  );
});

client.login(config.discordToken);
