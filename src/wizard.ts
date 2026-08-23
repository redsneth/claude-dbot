import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { addShare, getMaxTier, hasToken, listSharesByOwner, removeShare, setMaxTier, setToken } from "./db.js";
import { isModelKey, MODELS } from "./models.js";

/**
 * DM setup wizard. One bot DM evolves through the steps via interaction.update():
 *   intro -> token modal -> sharing select -> model-cap select -> summary
 * All customIds are namespaced "wiz:"; index.ts routes them here.
 */

function introPayload(alreadyRegistered: boolean) {
  const content = [
    "## Claude bot setup",
    "I connect this server to Claude using **your own Claude subscription** — no API key, no billing.",
    "",
    "**What you'll need:** a token from Claude Code. In any terminal, run:",
    "```",
    "claude setup-token",
    "```",
    "…log in when it asks, and copy the `sk-ant-oat01-…` string it prints.",
    "",
    "**Trust note:** your token is stored encrypted on the bot's host machine, but the host admin " +
      "could technically recover it, and anyone you share with spends your real subscription quota. " +
      "Only continue if you're okay with that.",
    alreadyRegistered ? "\nYou already have a token registered — you can replace it or keep it." : "",
  ].join("\n");

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("wiz:start")
      .setLabel(alreadyRegistered ? "Replace my token" : "I have my token")
      .setStyle(ButtonStyle.Primary),
    ...(alreadyRegistered
      ? [new ButtonBuilder().setCustomId("wiz:keep").setLabel("Keep current token").setStyle(ButtonStyle.Secondary)]
      : []),
    new ButtonBuilder().setCustomId("wiz:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
  return { content, components: [buttons] };
}

function sharePayload() {
  const select = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("wiz:share")
      .setPlaceholder("Who may use your subscription?")
      .addOptions(
        { label: "Only me", value: "me", description: "Nobody else can spend your quota" },
        {
          label: "Everyone on the server",
          value: "everyone",
          description: "Anyone may use your sub when theirs is missing or rate-limited",
        },
        {
          label: "Everyone — public channels only",
          value: "everyone_public",
          description: "Same, but only where @everyone can see, so usage stays visible to you",
        },
        {
          label: "Specific people (choose later)",
          value: "specific",
          description: "Start private; grant people with /share @user in the server",
        },
      ),
  );
  return {
    content:
      "**Token saved ✓**\n\n### Step 2 of 3 — Sharing\n" +
      "Should other server members be able to use your subscription through the bot? " +
      "You can change this anytime with `/share` and `/unshare`.",
    components: [select],
  };
}

function policyPayload() {
  const select = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("wiz:policy")
      .setPlaceholder("Largest model others may use on your sub")
      .addOptions(
        { label: "Any model (no cap)", value: "any" },
        { label: "Up to Fable 5", value: "fable", description: "Most capable, burns quota fastest" },
        { label: "Up to Opus 5", value: "opus" },
        { label: "Up to Sonnet 5", value: "sonnet", description: "Good default if you guard your quota" },
        { label: "Haiku 4.5 only", value: "haiku", description: "Cheapest on quota" },
      ),
  );
  return {
    content:
      "### Step 3 of 3 — Model cap\n" +
      "Bigger models burn through your 5-hour and weekly limits much faster. " +
      "Cap what **others** may run on your sub — your own asks are never capped. " +
      "Change it anytime with `/policy`.",
    components: [select],
  };
}

function summaryPayload(userId: string): { content: string; components: [] } {
  const shares = listSharesByOwner(userId);
  const everyone = shares.find((s) => s.grantee === "*");
  const sharing = everyone
    ? everyone.publicOnly
      ? "everyone on the server (public channels only)"
      : "everyone on the server"
    : shares.length
      ? `${shares.length} specific ${shares.length === 1 ? "person" : "people"}`
      : "only you";
  const tier = getMaxTier(userId);
  const cap = tier === "any" || !isModelKey(tier) ? "any model" : `up to ${MODELS[tier].label}`;
  return {
    content: [
      "## You're set! ✓",
      `- Token: registered (encrypted)`,
      `- Sharing: **${sharing}**`,
      `- Others may use: **${cap}**`,
      "",
      "**Using the bot:** `/ask` in any channel, or just @mention it in a conversation — " +
        "it reads recent messages for context.",
      "**Useful later:** `/status` (your state) · `/usage` (what your sub spent, by whom) · " +
        "`/share @user` · `/policy` · rerun `/setup` anytime.",
    ].join("\n"),
    components: [],
  };
}

function tokenModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("wiz:token-modal")
    .setTitle("Paste your Claude token")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("token")
          .setLabel("Output of `claude setup-token`")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("sk-ant-oat01-…")
          .setRequired(true),
      ),
    );
}

export async function startSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.user.send(introPayload(hasToken(interaction.user.id)));
  } catch {
    await interaction.reply({
      content:
        "I couldn't DM you — your privacy settings block DMs from server members. " +
        "Enable them (Server → Privacy Settings → Direct Messages) and rerun **/setup**, " +
        "or use **/register** for the quick non-guided version.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({ content: "📬 Check your DMs — the setup wizard is waiting there.", flags: MessageFlags.Ephemeral });
}

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  switch (interaction.customId) {
    case "wiz:start":
      return void (await interaction.showModal(tokenModal()));
    case "wiz:keep":
      return void (await interaction.update(sharePayload()));
    case "wiz:cancel":
      return void (await interaction.update({ content: "Setup cancelled. Rerun **/setup** whenever you like.", components: [] }));
  }
}

export async function handleTokenModal(interaction: ModalSubmitInteraction): Promise<void> {
  const token = interaction.fields.getTextInputValue("token").trim();
  if (token.length < 20 || /\s/.test(token)) {
    await interaction.reply(
      "That doesn't look like a token — run `claude setup-token` and paste the full `sk-ant-oat01-…` string. " +
        "Click the button above to try again.",
    );
    return;
  }
  setToken(interaction.user.id, token);
  if (interaction.isFromMessage()) await interaction.update(sharePayload());
  else await interaction.reply(sharePayload());
}

export async function handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const choice = interaction.values[0] ?? "";
  if (interaction.customId === "wiz:share") {
    if (choice === "everyone") addShare(interaction.user.id, "*", false);
    else if (choice === "everyone_public") addShare(interaction.user.id, "*", true);
    else removeShare(interaction.user.id, "*");
    return void (await interaction.update(policyPayload()));
  }
  if (interaction.customId === "wiz:policy") {
    setMaxTier(interaction.user.id, choice);
    return void (await interaction.update(summaryPayload(interaction.user.id)));
  }
}
