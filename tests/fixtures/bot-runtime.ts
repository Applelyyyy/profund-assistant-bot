// Test-only Discord adapter. The real bot process, database, Redis and shutdown path run unchanged.
import { client } from "../../apps/bot/src/discord";
const config = JSON.parse(process.env.BOT_TEST_VOICE!);
const members = new Map<string, unknown>();
const guild = {
  id: config.guildId,
  voiceStates: {
    cache: new Map(
      Object.entries(config.members).map(([id, channelId]) => [
        id,
        { id, channelId },
      ]),
    ),
  },
  members: {
    fetch: async (id: string) => {
      if (id === config.slowMember) {
        console.log("maintenance.started");
        await new Promise((r) => setTimeout(r, 4000));
        console.log("maintenance.finished");
      }
      const member = members.get(id);
      if (!member)
        throw Object.assign(new Error("Missing synthetic member"), {
          code: 10007,
        });
      return member;
    },
    fetchMe: async () => ({ permissions: { has: () => true } }),
  },
  channels: {
    fetch: async (id: string) => ({
      id,
      type: 2,
      guild,
      permissionsFor: () => ({ has: () => true }),
    }),
  },
};
for (const [id, channelId] of Object.entries(config.members))
  members.set(id, {
    id,
    displayName: id,
    guild,
    roles: { cache: new Map([[config.taRole, true]]) },
    voice: { channelId },
    send: async () => ({}),
  });
Object.defineProperty(client, "user", {
  value: { id: "100000000000000099" },
  configurable: true,
});
client.guilds.fetch = (async () =>
  guild) as unknown as typeof client.guilds.fetch;
client.isReady = (() => true) as typeof client.isReady;
client.login = async () => "test-only-token";
void import("../../apps/bot/src/index").catch((error) => {
  console.error(error);
  process.exit(1);
});
