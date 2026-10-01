import { createServerFn } from "@tanstack/react-start";

type GiphyImage = {
  url: string;
  width?: string;
  height?: string;
};

type GiphyResult = {
  id: string;
  title: string;
  images: {
    fixed_width: GiphyImage;
    fixed_width_small: GiphyImage;
    original: GiphyImage;
  };
};

export const giphySearch = createServerFn({ method: "GET" })
  .validator((input: { query: string; kind: "gif" | "sticker" }) => input)
  .handler(async ({ data }) => {
    const key = process.env["GIPHY_API_KEY"];
    if (!key) throw new Error("Giphy is not configured on the server.");
    const endpoint = data.kind === "sticker" ? "stickers/search" : "gifs/search";
    const params = new URLSearchParams({ api_key: key, q: data.query || "game of thrones", limit: "24", rating: "pg-13" });
    const response = await fetch(`https://api.giphy.com/v1/${endpoint}?${params}`);
    if (!response.ok) throw new Error("Giphy request failed.");
    const body = (await response.json()) as { data: GiphyResult[] };
    return body.data ?? [];
  });