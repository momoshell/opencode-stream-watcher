import type { Plugin } from "@opencode-ai/plugin";

export const StreamWatchdog: Plugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "stream-watchdog",
      level: "info",
      message: "loaded",
    },
  });

  return {
    event: async () => {},
  };
};
