// Checkpoint: Steam live status
// A tiny helper that asks Steam what someone is playing.
// It runs on Supabase so your Steam API key stays secret.
//
// Setup: Supabase → Edge Functions → Deploy a new function → Via Editor,
// name it  steam-status , paste this whole file, Deploy.
// Then add a secret named STEAM_API_KEY, and turn OFF "Verify JWT".

const STEAM_KEY = Deno.env.get("STEAM_API_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=30" },
  });
}

const STATES = ["offline", "online", "busy", "away", "snooze", "looking to trade", "looking to play"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!STEAM_KEY) return json({ error: "STEAM_API_KEY secret is not set" }, 500);

  let id = (new URL(req.url).searchParams.get("id") ?? "").trim();
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) return json({ error: "bad id" }, 400);

  try {
    // Turn a custom URL name (steamcommunity.com/id/NAME) into a Steam ID
    if (!/^\d{17}$/.test(id)) {
      const r = await fetch(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_KEY}&vanityurl=${encodeURIComponent(id)}`);
      const d = await r.json();
      if (d?.response?.success !== 1) return json({ error: "not found" }, 404);
      id = d.response.steamid;
    }

    const r = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${id}`);
    const player = (await r.json())?.response?.players?.[0];
    if (!player) return json({ error: "not found" }, 404);

    return json({
      steamid: id,
      name: player.personaname,
      private: player.communityvisibilitystate !== 3,
      state: STATES[player.personastate] ?? "offline",
      game: player.gameextrainfo ?? null,
      gameId: player.gameid ?? null,
    });
  } catch (_err) {
    return json({ error: "Steam didn't answer" }, 502);
  }
});
