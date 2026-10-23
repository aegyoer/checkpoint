// Checkpoint: Steam helper
// Runs on Supabase so your Steam API key stays secret. It does 5 jobs:
//   ?action=start     begin "Sign in through Steam" (needs the person to be signed in to Checkpoint)
//   ?action=callback  Steam sends people back here; we double-check with Steam, then save the link
//   ?action=games     someone's Steam games + hours (only for Steam accounts linked through Steam sign-in)
//   ?action=status    what someone is playing right now
//   ?action=resolve   turn a custom Steam name into a Steam ID number
//   ?action=achievements  one game's achievements (names, icons, unlocked or not)
//   ?action=achsummary    unlocked / total achievements for up to 25 games at once
//   ?action=achtotal      ALL achievements across someone's played games (saved, refreshed hourly)
//
// Setup: Supabase → Edge Functions → Deploy a new function → Via Editor,
// name it exactly  steam , paste this whole file, Deploy.
// Then add the secret STEAM_API_KEY, and turn OFF "Verify JWT" for this function.

import { createClient } from "npm:@supabase/supabase-js@2";

const STEAM_KEY = Deno.env.get("STEAM_API_KEY") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SELF = `${SB_URL}/functions/v1/steam`;

// Supabase gives every function its own admin key automatically
function adminKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    return keys.default ?? (Object.values(keys)[0] as string) ?? "";
  } catch { return ""; }
}
const ADMIN_KEY = adminKey();
// Made only when needed, so the helper still starts even if a key is missing
let _admin: ReturnType<typeof createClient> | null = null;
const admin = new Proxy({} as ReturnType<typeof createClient>, {
  get(_t, prop) {
    if (!ADMIN_KEY) throw new Error("Supabase admin key missing");
    _admin ??= createClient(SB_URL, ADMIN_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    return (_admin as any)[prop];
  },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (body: unknown, status = 200, cache = 0) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": cache ? `public, max-age=${cache}` : "no-store" },
  });
const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to } });

// ---------- small helpers ----------
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

async function sign(text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(ADMIN_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))));
}

async function steamApi(path: string, params: Record<string, string>) {
  const r = await fetch(`https://api.steampowered.com/${path}/?key=${STEAM_KEY}&${new URLSearchParams(params)}`);
  if (!r.ok) throw new Error(`Steam ${r.status}`);
  return await r.json();
}

async function resolveId(id: string): Promise<string | null> {
  if (/^\d{17}$/.test(id)) return id;
  const d = await steamApi("ISteamUser/ResolveVanityURL/v1", { vanityurl: id });
  return d?.response?.success === 1 ? d.response.steamid : null;
}

async function summary(steamid: string) {
  const d = await steamApi("ISteamUser/GetPlayerSummaries/v2", { steamids: steamid });
  return d?.response?.players?.[0] ?? null;
}

// Which Steam account is linked (through Steam sign-in) to this Checkpoint user
async function linkedSteamId(user: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(user)) return null;
  const { data } = await admin.from("linked_accounts").select("account_id").eq("user_id", user).eq("provider", "steam").maybeSingle();
  return data?.account_id ?? null;
}

// A player's achievements for one game (null if the game has none, or the profile is private)
async function playerAchievements(steamid: string, appid: number, withNames = true) {
  const r = await fetch(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${STEAM_KEY}&steamid=${steamid}&appid=${appid}${withNames ? "&l=english" : ""}`);
  const d = await r.json().catch(() => null);
  const ps = d?.playerstats;
  if (!ps?.success || !Array.isArray(ps.achievements)) return null;
  return ps.achievements as { apiname: string; achieved: number; unlocktime: number; name?: string; description?: string }[];
}

const STATES = ["offline", "online", "busy", "away", "snooze", "looking to trade", "looking to play"];

// ---------- the jobs ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const q = url.searchParams;
  const action = q.get("action") ?? "hello";
  if (action === "hello") {
    return json({ ok: true, message: "The Checkpoint Steam helper is running ♡", steamKey: STEAM_KEY ? "set" : "MISSING: add STEAM_API_KEY in Edge Functions → Secrets", adminKey: ADMIN_KEY ? "set" : "missing" });
  }

  try {
    if (!STEAM_KEY) return json({ error: "STEAM_API_KEY secret is not set" }, 500);

    // What someone is playing right now
    if (action === "status" || action === "resolve") {
      const raw = (q.get("id") ?? "").trim();
      if (!/^[A-Za-z0-9_-]{2,64}$/.test(raw)) return json({ error: "bad id" }, 400);
      const steamid = await resolveId(raw);
      if (!steamid) return json({ error: "not found" }, 404);
      if (action === "resolve") return json({ steamid }, 200, 3600);
      const p = await summary(steamid);
      if (!p) return json({ error: "not found" }, 404);
      return json({
        steamid, name: p.personaname, private: p.communityvisibilitystate !== 3,
        state: STATES[p.personastate] ?? "offline", game: p.gameextrainfo ?? null, gameId: p.gameid ?? null,
      }, 200, 30);
    }

    // Someone's games and hours (only verified links)
    if (action === "games") {
      const user = q.get("user") ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(user)) return json({ error: "bad user" }, 400);
      const { data: link } = await admin.from("linked_accounts").select("account_id, display_name, avatar, ach_unlocked, ach_total, perfect, stats_at")
        .eq("user_id", user).eq("provider", "steam").maybeSingle();
      if (!link) return json({ linked: false }, 200, 60);
      const d = await steamApi("IPlayerService/GetOwnedGames/v1", {
        steamid: link.account_id, include_appinfo: "1", include_played_free_games: "1",
      });
      const list = d?.response?.games;
      const base = {
        linked: true, steamid: link.account_id, name: link.display_name, avatar: link.avatar,
        stats: { unlocked: link.ach_unlocked, total: link.ach_total, perfect: link.perfect, at: link.stats_at },
      };
      if (!Array.isArray(list)) return json({ ...base, private: true, games: [] }, 200, 120);
      const games = list.map((g: any) => ({
        appid: g.appid, name: g.name,
        hours: Math.round((g.playtime_forever ?? 0) / 6) / 10,
        recent: Math.round((g.playtime_2weeks ?? 0) / 6) / 10,
        last: g.rtime_last_played ?? 0,
      }));
      return json({ ...base, private: false, count: games.length, games }, 200, 300);
    }

    // One game's achievements, with names and icons
    if (action === "achievements") {
      const appid = Number(q.get("appid"));
      if (!Number.isInteger(appid) || appid <= 0) return json({ error: "bad game" }, 400);
      const steamid = await linkedSteamId(q.get("user") ?? "");
      if (!steamid) return json({ linked: false }, 200, 60);
      const mine = await playerAchievements(steamid, appid);
      if (!mine) return json({ linked: true, appid, total: 0, done: 0, list: [] }, 200, 300);
      const schema = await steamApi("ISteamUserStats/GetSchemaForGame/v2", { appid: String(appid), l: "english" }).catch(() => null);
      const info = new Map<string, any>((schema?.game?.availableGameStats?.achievements ?? []).map((a: any) => [a.name, a]));
      const list = mine.map((a) => {
        const s = info.get(a.apiname) ?? {};
        return {
          name: s.displayName ?? a.name ?? a.apiname,
          desc: s.description || a.description || (s.hidden ? "Hidden achievement" : ""),
          icon: a.achieved ? (s.icon ?? "") : (s.icongray ?? s.icon ?? ""),
          done: a.achieved === 1, at: a.unlocktime ?? 0,
        };
      }).sort((x, y) => Number(y.done) - Number(x.done) || y.at - x.at);
      const done = list.filter((a) => a.done).length;
      return json({ linked: true, appid, total: list.length, done, list }, 200, 300);
    }

    // Every achievement across all played games (saved; recounted at most once an hour)
    if (action === "achtotal") {
      const user = q.get("user") ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(user)) return json({ error: "bad user" }, 400);
      const { data: link } = await admin.from("linked_accounts").select("account_id, ach_unlocked, ach_total, perfect, stats_at")
        .eq("user_id", user).eq("provider", "steam").maybeSingle();
      if (!link) return json({ linked: false });
      const saved = { linked: true, unlocked: link.ach_unlocked, total: link.ach_total, perfect: link.perfect, at: link.stats_at };
      if (link.stats_at && Date.now() - Date.parse(link.stats_at) < 60 * 60 * 1000) return json({ ...saved, cached: true });
      const d = await steamApi("IPlayerService/GetOwnedGames/v1", { steamid: link.account_id, include_played_free_games: "1" });
      if (!Array.isArray(d?.response?.games)) return json({ ...saved, private: true });
      const played = d.response.games.filter((g: any) => (g.playtime_forever ?? 0) > 0)
        .sort((a: any, b: any) => b.playtime_forever - a.playtime_forever).slice(0, 400);
      let unlocked = 0, total = 0, perfect = 0;
      for (let i = 0; i < played.length; i += 15) {        // 15 games at a time, so Steam isn't flooded
        const batch = await Promise.all(played.slice(i, i + 15).map((g: any) => playerAchievements(link.account_id, g.appid, false).catch(() => null)));
        for (const a of batch) {
          if (!a || !a.length) continue;
          const done = a.filter((x) => x.achieved === 1).length;
          unlocked += done; total += a.length;
          if (done === a.length) perfect++;
        }
      }
      const at = new Date().toISOString();
      await admin.from("linked_accounts").update({ ach_unlocked: unlocked, ach_total: total, perfect, stats_at: at })
        .eq("user_id", user).eq("provider", "steam");
      return json({ linked: true, unlocked, total, perfect, at });
    }

    // Unlocked / total for many games at once
    if (action === "achsummary") {
      const steamid = await linkedSteamId(q.get("user") ?? "");
      if (!steamid) return json({ linked: false }, 200, 60);
      const appids = [...new Set((q.get("appids") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 25);
      const results = await Promise.all(appids.map(async (appid) => {
        const a = await playerAchievements(steamid, appid).catch(() => null);
        return a && a.length ? [appid, { done: a.filter((x) => x.achieved === 1).length, total: a.length }] : null;
      }));
      return json({ linked: true, games: Object.fromEntries(results.filter(Boolean) as any) }, 200, 300);
    }

    // Step 1 of "Sign in through Steam"
    if (action === "start") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: { user } } = await admin.auth.getUser(token);
      if (!user) return json({ error: "Please sign in to Checkpoint first" }, 401);
      const back = q.get("return") ?? "";
      if (!/^https:\/\/[^\s]+$/.test(back) && !/^http:\/\/localhost[:/]/.test(back)) return json({ error: "bad return link" }, 400);
      const payload = b64url(new TextEncoder().encode(JSON.stringify({ u: user.id, r: back, e: Date.now() + 10 * 60 * 1000 })));
      const state = `${payload}.${await sign(payload)}`;
      const p = new URLSearchParams({
        "openid.ns": "http://specs.openid.net/auth/2.0",
        "openid.mode": "checkid_setup",
        "openid.return_to": `${SELF}?action=callback&state=${state}`,
        "openid.realm": new URL(SB_URL).origin,
        "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
        "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
      });
      return json({ url: `https://steamcommunity.com/openid/login?${p}` });
    }

    // Step 2: Steam sends the person back here
    if (action === "callback") {
      const [payload, sig] = (q.get("state") ?? "").split(".");
      if (!payload || !sig || sig !== await sign(payload)) return json({ error: "bad state" }, 400);
      const st = JSON.parse(fromB64url(payload));
      const back = (result: string) => redirect(`${st.r}#steam=${result}`);
      if (Date.now() > st.e) return back("expired");
      if (q.get("openid.mode") !== "id_res") return back("cancelled");
      if (q.get("openid.op_endpoint") !== "https://steamcommunity.com/openid/login") return back("error");
      if (!(q.get("openid.return_to") ?? "").startsWith(`${SELF}?action=callback`)) return back("error");
      const m = (q.get("openid.claimed_id") ?? "").match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
      if (!m) return back("error");

      // Ask Steam itself whether this sign-in is real
      const check = new URLSearchParams();
      for (const [k, v] of q) if (k.startsWith("openid.")) check.set(k, v);
      check.set("openid.mode", "check_authentication");
      const r = await fetch("https://steamcommunity.com/openid/login", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: check,
      });
      if (!/is_valid\s*:\s*true/.test(await r.text())) return back("error");

      const steamid = m[1];
      const p = await summary(steamid).catch(() => null);
      const { error } = await admin.from("linked_accounts").upsert({
        user_id: st.u, provider: "steam", account_id: steamid,
        display_name: p?.personaname ?? null, avatar: p?.avatarfull ?? null, linked_at: new Date().toISOString(),
      }, { onConflict: "user_id,provider" });
      if (error) return back(error.code === "23505" ? "taken" : "error");
      return back("linked");
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    return json({ error: "Something went wrong: " + String((err as Error)?.message ?? err) }, 502);
  }
});
