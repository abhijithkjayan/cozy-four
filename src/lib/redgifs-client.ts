// RedGifs can't be called from the browser here: its CORS only allows www.redgifs.com for the
// search and gif endpoints. Everything goes through the server (see giphy.functions.ts).
import { redgifsUrl } from "@/lib/giphy.functions";

/** Fresh playable link for a clip already in the chat, e.g. when a saved one has expired. */
export async function freshRedgifs(id: string) {
  return redgifsUrl({ data: { id } }).catch(() => null);
}
