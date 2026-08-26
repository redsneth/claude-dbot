import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask Claude (uses your sub, or one shared with you)")
    .addStringOption((o) => o.setName("question").setDescription("What do you want to ask?").setRequired(true))
    .addStringOption((o) =>
      o.setName("project").setDescription("Project name from projects.json (overrides channel default)"),
    )
    .addStringOption((o) =>
      o
        .setName("model")
        .setDescription("Model to use (default set by the host; donors may cap what their sub allows)")
        .addChoices(
          { name: "Fable 5 (most capable, burns quota fastest)", value: "fable" },
          { name: "Opus 5", value: "opus" },
          { name: "Sonnet 5", value: "sonnet" },
          { name: "Haiku 4.5 (fastest, cheapest on quota)", value: "haiku" },
        ),
    )
    .addStringOption((o) =>
      o
        .setName("sub")
        .setDescription("Whose subscription pays: yours first with donated fallback (default), yours only, or donated only")
        .addChoices(
          { name: "auto — mine first, donated fallback", value: "auto" },
          { name: "mine — only my own sub", value: "mine" },
          { name: "donated — spare my own sub", value: "donated" },
        ),
    ),

  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Guided setup in your DMs: register your Claude sub, pick sharing and model caps"),

  new SlashCommandBuilder()
    .setName("register")
    .setDescription("Quick non-guided token registration (from `claude setup-token`)"),

  new SlashCommandBuilder().setName("unregister").setDescription("Delete your stored token and all your shares"),

  new SlashCommandBuilder()
    .setName("share")
    .setDescription("Let someone (or everyone) use your Claude subscription through this bot")
    .addUserOption((o) => o.setName("user").setDescription("Who to share with (omit to share with everyone)"))
    .addBooleanOption((o) =>
      o
        .setName("public_only")
        .setDescription("Only allow use in channels visible to everyone, so you can see how your sub is used"),
    ),

  new SlashCommandBuilder()
    .setName("unshare")
    .setDescription("Revoke a share of your subscription")
    .addUserOption((o) => o.setName("user").setDescription("Whose access to revoke (omit to revoke 'everyone')")),

  new SlashCommandBuilder().setName("status").setDescription("Your token, shares, and current rate-limit cooldowns"),

  new SlashCommandBuilder()
    .setName("policy")
    .setDescription("Cap which models others may run on YOUR shared subscription")
    .addStringOption((o) =>
      o
        .setName("max_model")
        .setDescription("Largest model others may use on your sub (your own asks are never capped)")
        .setRequired(true)
        .addChoices(
          { name: "any (no cap)", value: "any" },
          { name: "up to Fable 5", value: "fable" },
          { name: "up to Opus 5", value: "opus" },
          { name: "up to Sonnet 5", value: "sonnet" },
          { name: "Haiku 4.5 only", value: "haiku" },
        ),
    ),

  new SlashCommandBuilder()
    .setName("usage")
    .setDescription("How much of your subscription this bot has consumed, and by whom")
    .addIntegerOption((o) =>
      o.setName("days").setDescription("Look-back window in days (default 7)").setMinValue(1).setMaxValue(90),
    ),

  new SlashCommandBuilder()
    .setName("project")
    .setDescription("Manage this channel's default project")
    .addSubcommand((s) =>
      s
        .setName("set")
        .setDescription("Set this channel's default project")
        .addStringOption((o) => o.setName("name").setDescription("Project name from projects.json").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("list").setDescription("List configured projects"))
    .addSubcommand((s) => s.setName("clear").setDescription("Clear this channel's default project")),

  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Forget this channel's Claude conversation (start a fresh session)"),

  new SlashCommandBuilder()
    .setName("remember")
    .setDescription("Teach the bot a fact about yourself (e.g. how to address you, what you work on)")
    .addStringOption((o) =>
      o.setName("note").setDescription("The fact (max 300 chars; you can store up to 10)").setRequired(true).setMaxLength(300),
    ),

  new SlashCommandBuilder().setName("forget").setDescription("Delete everything the bot remembers about you"),

  new SlashCommandBuilder()
    .setName("botmode")
    .setDescription("Set how the bot behaves in this channel (requires Manage Channels)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("Behavior for this channel")
        .setRequired(true)
        .addChoices(
          { name: "off — bot never responds here", value: "off" },
          { name: "chat — short plain-prose answers only", value: "chat" },
          { name: "thread — long answers go into threads", value: "thread" },
          { name: "free — full answers inline (default)", value: "free" },
        ),
    ),
].map((c) => c.toJSON());
