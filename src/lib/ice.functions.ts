import { createServerFn } from "@tanstack/react-start";

// Returns TURN relay servers when configured (TURN_URLS comma-separated, TURN_USERNAME, TURN_CREDENTIAL).
// A relay is what lets calls connect when both phones are on mobile data / strict Wi-Fi.
export const getTurnServers = createServerFn({ method: "GET" }).handler(async () => {
  const urls = (process.env["TURN_URLS"] ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const username = process.env["TURN_USERNAME"];
  const credential = process.env["TURN_CREDENTIAL"];
  if (!urls.length || !username || !credential) return [] as { urls: string[]; username: string; credential: string }[];
  return [{ urls, username, credential }];
});
