import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commandDefinitions } from "./commands.js";

const rest = new REST().setToken(config.discordToken);

if (config.devGuildId) {
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.devGuildId), {
    body: commandDefinitions,
  });
  console.log(`Registered ${commandDefinitions.length} guild commands for guild ${config.devGuildId} (instant).`);
} else {
  await rest.put(Routes.applicationCommands(config.clientId), { body: commandDefinitions });
  console.log(`Registered ${commandDefinitions.length} global commands (may take up to an hour to appear).`);
}
