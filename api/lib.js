// ============================================================
// api/lib.js  -  shared helpers for the API service
// Runtime: Node 18 or newer (global fetch is required)
// ============================================================
'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

// service role client - bypasses RLS, must stay on the server only
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const DISCORD_API = 'https://discord.com/api/v10';
const MANAGE_GUILD = 0x20;
const ADMINISTRATOR = 0x8;

// ------------------------------------------------------------
// small helpers
// ------------------------------------------------------------
function bad(res, code, message) {
  return res.status(code).json({ error: message });
}

function bearer(req) {
  const raw = req.headers.authorization || '';
  if (!raw.startsWith('Bearer ')) return null;
  return raw.slice(7).trim();
}

// Discord rate limits hard. Wait the amount it asks for and
// try again, up to twice, before giving up.
async function discordFetch(path, token, isBot, attempt) {
  const tries = attempt || 0;
  const prefix = isBot ? 'Bot ' : 'Bearer ';

  const r = await fetch(DISCORD_API + path, {
    headers: { Authorization: prefix + token }
  });

  if (r.status === 429 && tries < 2) {
    let waitMs = 1000;

    try {
      const body = await r.json();
      if (body && body.retry_after) waitMs = Math.ceil(body.retry_after * 1000) + 250;
    } catch (e) {
      // no body, fall back to one second
    }

    await new Promise(function (done) { setTimeout(done, Math.min(waitMs, 5000)); });
    return discordFetch(path, token, isBot, tries + 1);
  }

  if (!r.ok) {
    const text = await r.text();
    const err = new Error('Discord API ' + r.status + ': ' + text);
    err.status = r.status;
    throw err;
  }

  return r.json();
}

// ------------------------------------------------------------
// The server page loads settings, channels and roles at once.
// Without this, all three would ask Discord for the same guild
// list in the same instant and trip the rate limit.
// ------------------------------------------------------------
const GUILD_TTL_MS = 30000;
const guildCache = new Map();
const guildInflight = new Map();

async function fetchUserGuilds(token) {
  const cached = guildCache.get(token);
  if (cached && Date.now() - cached.at < GUILD_TTL_MS) return cached.data;

  const running = guildInflight.get(token);
  if (running) return running;

  const request = discordFetch('/users/@me/guilds', token, false)
    .then(function (data) {
      if (guildCache.size > 200) guildCache.clear();
      guildCache.set(token, { at: Date.now(), data: data });
      guildInflight.delete(token);
      return data;
    })
    .catch(function (e) {
      guildInflight.delete(token);
      throw e;
    });

  guildInflight.set(token, request);
  return request;
}

// ------------------------------------------------------------
// requireUser
// Reads the Supabase access token, validates it, upserts the
// user row, and puts the result on req.dashUser
// ------------------------------------------------------------
async function requireUser(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) return bad(res, 401, 'Missing bearer token');

    const { data, error } = await db.auth.getUser(token);
    if (error || !data || !data.user) return bad(res, 401, 'Invalid session');

    const u = data.user;
    const meta = u.user_metadata || {};
    const discordId =
      meta.provider_id || meta.sub || (u.identities && u.identities[0] && u.identities[0].id);

    if (!discordId) return bad(res, 401, 'No discord identity on this account');

    const row = {
      id: u.id,
      discord_id: String(discordId),
      username: meta.full_name || meta.name || meta.user_name || null,
      avatar: meta.avatar_url || null,
      last_login: new Date().toISOString()
    };

    await db.from('dashboard_users').upsert(row, { onConflict: 'id' });

    req.dashUser = row;
    req.accessToken = token;
    next();
  } catch (e) {
    console.error('requireUser failed:', e.message);
    return bad(res, 500, 'Auth check failed');
  }
}

// ------------------------------------------------------------
// listManageableGuilds
// Uses the user's Discord provider token (sent by the frontend
// in the x-discord-token header) to list servers where the user
// has Manage Server, then intersects with guilds the bot is in.
// ------------------------------------------------------------
async function listManageableGuilds(req) {
  const providerToken = req.headers['x-discord-token'];
  if (!providerToken) {
    const err = new Error('Missing x-discord-token header');
    err.status = 400;
    throw err;
  }

  const guilds = await fetchUserGuilds(providerToken);

  const manageable = guilds.filter(function (g) {
    const perms = BigInt(g.permissions || '0');
    const canManage = (perms & BigInt(MANAGE_GUILD)) === BigInt(MANAGE_GUILD);
    const isAdmin = (perms & BigInt(ADMINISTRATOR)) === BigInt(ADMINISTRATOR);
    return g.owner === true || canManage || isAdmin;
  });

  const ids = manageable.map(function (g) { return g.id; });
  if (ids.length === 0) return [];

  const { data: known } = await db
    .from('guilds')
    .select('id, name, icon, premium, member_count, active')
    .in('id', ids);

  const knownMap = {};
  (known || []).forEach(function (g) { knownMap[g.id] = g; });

  return manageable.map(function (g) {
    const k = knownMap[g.id];
    return {
      id: g.id,
      name: g.name,
      icon: g.icon,
      bot_present: Boolean(k && k.active),
      premium: Boolean(k && k.premium),
      member_count: k ? k.member_count : 0
    };
  });
}

// ------------------------------------------------------------
// requireGuildAccess
// Confirms the caller really controls :guildId, then caches the
// grant in guild_access so later calls are one cheap query.
// ------------------------------------------------------------
async function requireGuildAccess(req, res, next) {
  try {
    const guildId = req.params.guildId;
    if (!guildId) return bad(res, 400, 'Missing guild id');

    const { data: cached } = await db
      .from('guild_access')
      .select('guild_id')
      .eq('user_id', req.dashUser.id)
      .eq('guild_id', guildId)
      .maybeSingle();

    if (cached) {
      req.guildId = guildId;
      return next();
    }

    const guilds = await listManageableGuilds(req);
    const match = guilds.find(function (g) { return g.id === guildId; });
    if (!match) return bad(res, 403, 'You do not manage this server');
    if (!match.bot_present) return bad(res, 409, 'The bot is not in this server yet');

    await db.from('guild_access').upsert(
      { user_id: req.dashUser.id, guild_id: guildId, role: 'admin' },
      { onConflict: 'user_id,guild_id' }
    );

    req.guildId = guildId;
    next();
  } catch (e) {
    console.error('requireGuildAccess failed:', e.message);
    return bad(res, e.status || 500, e.message);
  }
}

// ------------------------------------------------------------
// job queue + audit
// ------------------------------------------------------------
async function enqueueJob(guildId, type, payload) {
  const { error } = await db
    .from('bot_jobs')
    .insert({ guild_id: guildId, type: type, payload: payload || {} });
  if (error) throw new Error('enqueueJob: ' + error.message);
}

async function logAudit(guildId, actorDiscordId, action, detail) {
  await db.from('audit_log').insert({
    guild_id: guildId,
    actor_discord_id: actorDiscordId || null,
    action: action,
    detail: detail || {}
  });
}

module.exports = {
  db,
  bad,
  discordFetch,
  requireUser,
  requireGuildAccess,
  listManageableGuilds,
  enqueueJob,
  logAudit
};
