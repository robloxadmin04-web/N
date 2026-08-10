// ============================================================
// api/server.js  -  Express API for the dashboard
// Deploy as a Render WEB SERVICE
// Start command: node server.js
// ============================================================
'use strict';

const express  = require('express');
const cors     = require('cors');
const rateLimit = require('express-rate-limit');

const {
  db,
  bad,
  authOnly,
  requireUser,
  requireOwner,
  requireGuildAccess,
  listManageableGuilds,
  enqueueJob,
  logAudit,
  timingSafeCompare
} = require('./lib');

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const SITE_WEBHOOK_SECRET = process.env.SITE_WEBHOOK_SECRET || '';

app.use(express.json({ limit: '256kb' }));

// ------------------------------------------------------------
// CORS — restrict to the configured dashboard origin.
// Set ALLOWED_ORIGIN in your environment (e.g. https://yourdomain.com).
// Falls back to '*' only if unset, which is fine for local dev.
// ------------------------------------------------------------
app.use(
  cors({
    origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map(function (o) { return o.trim(); }),
    allowedHeaders: ['Content-Type', 'Authorization', 'x-discord-token', 'x-webhook-secret'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  })
);

// ------------------------------------------------------------
// Rate limiting
//
// Three tiers:
//   globalLimiter  — catches runaway clients before they hit anything
//   authLimiter    — tight cap on sign-in / access-check endpoints
//   apiLimiter     — normal dashboard API calls
// ------------------------------------------------------------

// 300 requests per minute per IP across the whole API.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' }
});

// 10 attempts per minute on auth endpoints.
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, try again in a minute.' }
});

// 60 requests per minute on normal API routes.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again in a minute.' }
});

app.use(globalLimiter);
app.use('/api/access', authLimiter);
app.use('/api', apiLimiter);

// ------------------------------------------------------------
// health
// ------------------------------------------------------------
app.get('/health', function (req, res) {
  res.json({ ok: true, service: 'dashboard-api', time: new Date().toISOString() });
});

// ------------------------------------------------------------
// POST /api/access/check
// Public. The landing page calls this before Discord sign in.
// Confirms a key exists and is enabled. This only gates entry,
// it does not decide who is owner.
// ------------------------------------------------------------
app.post('/api/access/check', async function (req, res) {
  const key = String(req.body.key || '').trim();
  if (!key) return bad(res, 400, 'Enter an access key');

  const { data: row } = await db
    .from('access_keys')
    .select('key, disabled')
    .eq('key', key)
    .maybeSingle();

  if (!row || row.disabled) return bad(res, 403, 'That access key is not valid');

  await db
    .from('access_keys')
    .update({ uses: (row.uses || 0) + 1, last_used: new Date().toISOString() })
    .eq('key', key);

  res.json({ ok: true });
});

// ------------------------------------------------------------
// POST /api/access/claim
// Runs right after Discord sign in. Ties the key to this account
// the first time it is used, and refuses it for anyone else.
// ------------------------------------------------------------
app.post('/api/access/claim', authOnly, async function (req, res) {
  const me = req.dashUser.discord_id;
  const key = String(req.body.key || '').trim();

  // Already linked to this account? Nothing more to do.
  const { data: mine } = await db
    .from('access_keys')
    .select('key')
    .eq('claimed_by', me)
    .eq('disabled', false)
    .limit(1);

  if (mine && mine.length) return res.json({ ok: true, key: mine[0].key });

  // A key was submitted, so bind it. Owners bind too, otherwise
  // their key stays unowned and the next person to type it takes it.
  if (key) {
    const { data: row } = await db
      .from('access_keys')
      .select('key, disabled, claimed_by')
      .eq('key', key)
      .maybeSingle();

    if (!row || row.disabled) return bad(res, 403, 'That access key is not valid');

    if (row.claimed_by && row.claimed_by !== me) {
      return bad(res, 403, 'That key is already linked to a different Discord account');
    }

    const { error } = await db
      .from('access_keys')
      .update({
        claimed_by: me,
        claimed_at: new Date().toISOString(),
        label: req.dashUser.username || null
      })
      .eq('key', key);

    if (error) return bad(res, 500, error.message);

    await logAudit(null, me, 'accesskey.bind', { key: key });
    return res.json({ ok: true, key: key });
  }

  // No key given. Owners are still allowed through.
  const { data: owner } = await db
    .from('owners')
    .select('discord_id')
    .eq('discord_id', me)
    .maybeSingle();

  if (owner) return res.json({ ok: true, owner: true });

  return bad(res, 400, 'Enter your access key on the sign in page');
});

// ------------------------------------------------------------
// GET /api/me
// ------------------------------------------------------------
app.get('/api/me', requireUser, function (req, res) {
  res.json({ user: req.dashUser });
});

// ------------------------------------------------------------
// GET /api/owner/me  -  is this signed in user an owner?
// ------------------------------------------------------------
app.get('/api/owner/me', requireUser, async function (req, res) {
  const { data } = await db
    .from('owners')
    .select('discord_id')
    .eq('discord_id', req.dashUser.discord_id)
    .maybeSingle();

  res.json({ owner: Boolean(data) });
});

// ------------------------------------------------------------
// GET /api/owner/keys  -  list every access key
// ------------------------------------------------------------
app.get('/api/owner/keys', requireUser, requireOwner, async function (req, res) {
  const { data, error } = await db
    .from('access_keys')
    .select('key, label, disabled, uses, last_used, created_at')
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) return bad(res, 500, error.message);
  res.json({ keys: data || [] });
});

// ------------------------------------------------------------
// POST /api/owner/keys  -  generate a new key
// ------------------------------------------------------------
app.post('/api/owner/keys', requireUser, requireOwner, async function (req, res) {
  const label = String(req.body.label || '').trim().slice(0, 60) || null;

  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = 'KEY-';
  for (let i = 0; i < 16; i++) {
    if (i === 8) key += '-';
    key += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  const { error } = await db.from('access_keys').insert({
    key: key,
    label: label,
    created_by: req.dashUser.discord_id
  });

  if (error) return bad(res, 500, error.message);

  await logAudit(null, req.dashUser.discord_id, 'accesskey.create', { label: label });
  res.json({ key: key, label: label });
});

// ------------------------------------------------------------
// PATCH /api/owner/keys/:key  -  enable or disable a key
// ------------------------------------------------------------
app.patch('/api/owner/keys/:key', requireUser, requireOwner, async function (req, res) {
  const disabled = Boolean(req.body.disabled);

  const { error } = await db
    .from('access_keys')
    .update({ disabled: disabled })
    .eq('key', req.params.key);

  if (error) return bad(res, 500, error.message);
  res.json({ ok: true });
});

// ------------------------------------------------------------
// DELETE /api/owner/keys/:key
// ------------------------------------------------------------
app.delete('/api/owner/keys/:key', requireUser, requireOwner, async function (req, res) {
  await db.from('access_keys').delete().eq('key', req.params.key);
  await logAudit(null, req.dashUser.discord_id, 'accesskey.delete', { key: req.params.key });
  res.json({ ok: true });
});

// ------------------------------------------------------------
// GET /api/guilds
// ------------------------------------------------------------
app.get('/api/guilds', requireUser, async function (req, res) {
  try {
    const guilds = await listManageableGuilds(req);
    res.json({ guilds: guilds });
  } catch (e) {
    return bad(res, e.status || 500, e.message);
  }
});

// ------------------------------------------------------------
// GET /api/guilds/:guildId/settings
// ------------------------------------------------------------
app.get('/api/guilds/:guildId/settings', requireUser, requireGuildAccess, async function (req, res) {
  const { data, error } = await db
    .from('guild_settings')
    .select('*')
    .eq('guild_id', req.guildId)
    .maybeSingle();

  if (error) return bad(res, 500, error.message);

  if (!data) {
    const { data: created, error: insErr } = await db
      .from('guild_settings')
      .insert({ guild_id: req.guildId })
      .select()
      .single();
    if (insErr) return bad(res, 500, insErr.message);
    return res.json({ settings: created });
  }

  res.json({ settings: data });
});

// ------------------------------------------------------------
// PUT /api/guilds/:guildId/settings
// ------------------------------------------------------------
const EDITABLE_SETTINGS = [
  'prefix',
  'welcome_enabled',
  'welcome_channel_id',
  'welcome_message',
  'autorole_enabled',
  'autorole_id',
  'log_channel_id',
  'updates_channel_id',
  'status_channel_id',
  'raid_protection',
  'min_account_age_days',
  'ticket_category_id',
  'ticket_archive_id',
  'ticket_staff_role_id',
  'ticket_log_channel_id'
];

app.put('/api/guilds/:guildId/settings', requireUser, requireGuildAccess, async function (req, res) {
  const patch = { guild_id: req.guildId };

  EDITABLE_SETTINGS.forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      patch[key] = req.body[key];
    }
  });

  if (Object.keys(patch).length === 1) return bad(res, 400, 'Nothing to update');

  if (patch.prefix && String(patch.prefix).length > 5) {
    return bad(res, 400, 'Prefix is too long');
  }
  if (patch.welcome_message && String(patch.welcome_message).length > 500) {
    return bad(res, 400, 'Welcome message is too long');
  }

  const { data, error } = await db
    .from('guild_settings')
    .upsert(patch, { onConflict: 'guild_id' })
    .select()
    .single();

  if (error) return bad(res, 500, error.message);

  await logAudit(req.guildId, req.dashUser.discord_id, 'settings.update', { keys: Object.keys(patch) });
  res.json({ settings: data });
});

// ------------------------------------------------------------
// GET /api/guilds/:guildId/channels  (from the bot cache table)
// The bot keeps guilds fresh; channels come straight from Discord
// through the bot token so the frontend never needs one.
// Returns text channels AND categories (categories power the
// ticket setup dropdowns).
// ------------------------------------------------------------
app.get('/api/guilds/:guildId/channels', requireUser, requireGuildAccess, async function (req, res) {
  try {
    const { discordFetch } = require('./lib');
    const channels = await discordFetch('/guilds/' + req.guildId + '/channels', process.env.DISCORD_BOT_TOKEN, true);

    const text = channels
      .filter(function (c) { return c.type === 0 || c.type === 5; })
      .map(function (c) { return { id: c.id, name: c.name, position: c.position }; })
      .sort(function (a, b) { return a.position - b.position; });

    const categories = channels
      .filter(function (c) { return c.type === 4; })
      .map(function (c) { return { id: c.id, name: c.name, position: c.position }; })
      .sort(function (a, b) { return a.position - b.position; });

    res.json({ channels: text, categories: categories });
  } catch (e) {
    return bad(res, e.status || 500, e.message);
  }
});

// ------------------------------------------------------------
// GET /api/guilds/:guildId/roles
// ------------------------------------------------------------
app.get('/api/guilds/:guildId/roles', requireUser, requireGuildAccess, async function (req, res) {
  try {
    const { discordFetch } = require('./lib');
    const roles = await discordFetch('/guilds/' + req.guildId + '/roles', process.env.DISCORD_BOT_TOKEN, true);
    const clean = roles
      .filter(function (r) { return !r.managed && r.name !== '@everyone'; })
      .map(function (r) { return { id: r.id, name: r.name, position: r.position }; })
      .sort(function (a, b) { return b.position - a.position; });
    res.json({ roles: clean });
  } catch (e) {
    return bad(res, e.status || 500, e.message);
  }
});

// ------------------------------------------------------------
// PREMIUM MEMBERS
// ------------------------------------------------------------
app.get('/api/guilds/:guildId/premium', requireUser, requireGuildAccess, async function (req, res) {
  const { data, error } = await db
    .from('premium_members')
    .select('*')
    .eq('guild_id', req.guildId)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) return bad(res, 500, error.message);
  res.json({ members: data || [] });
});

app.post('/api/guilds/:guildId/premium', requireUser, requireGuildAccess, async function (req, res) {
  const discordId = String(req.body.discord_id || '').trim();
  const tier = String(req.body.tier || 'basic').trim();
  const days = Number(req.body.days || 30);

  if (!/^\d{15,25}$/.test(discordId)) return bad(res, 400, 'Invalid discord id');
  if (!(days > 0 && days <= 3650)) return bad(res, 400, 'Days must be between 1 and 3650');

  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from('premium_members')
    .upsert(
      {
        guild_id: req.guildId,
        discord_id: discordId,
        tier: tier,
        source: 'dashboard',
        expires_at: expires,
        role_applied: false
      },
      { onConflict: 'guild_id,discord_id,tier' }
    )
    .select()
    .single();

  if (error) return bad(res, 500, error.message);

  await logAudit(req.guildId, req.dashUser.discord_id, 'premium.grant', { discordId, tier, days });
  res.json({ member: data });
});

app.delete('/api/guilds/:guildId/premium/:discordId', requireUser, requireGuildAccess, async function (req, res) {
  const discordId = req.params.discordId;
  const tier = req.query.tier ? String(req.query.tier) : null;

  let find = db
    .from('premium_members')
    .select('tier, role_applied')
    .eq('guild_id', req.guildId)
    .eq('discord_id', discordId);

  if (tier) find = find.eq('tier', tier);

  const { data: rows } = await find;
  if (!rows || rows.length === 0) return bad(res, 404, 'Not found');

  const { data: maps } = await db
    .from('premium_roles')
    .select('tier, role_id')
    .eq('guild_id', req.guildId);

  const roleFor = {};
  (maps || []).forEach(function (m) { roleFor[m.tier] = m.role_id; });

  for (const row of rows) {
    if (row.role_applied && roleFor[row.tier]) {
      await enqueueJob(req.guildId, 'remove_role', {
        discord_id: discordId,
        role_id: roleFor[row.tier],
        tier: row.tier
      });
    }
  }

  let del = db
    .from('premium_members')
    .delete()
    .eq('guild_id', req.guildId)
    .eq('discord_id', discordId);

  if (tier) del = del.eq('tier', tier);
  await del;

  await logAudit(req.guildId, req.dashUser.discord_id, 'premium.revoke', {
    discordId: discordId,
    tier: tier || 'all'
  });

  res.json({ ok: true });
});

// ------------------------------------------------------------
// PREMIUM ROLE MAPPING
// ------------------------------------------------------------
app.get('/api/guilds/:guildId/premium-roles', requireUser, requireGuildAccess, async function (req, res) {
  const { data, error } = await db.from('premium_roles').select('*').eq('guild_id', req.guildId);
  if (error) return bad(res, 500, error.message);
  res.json({ mappings: data || [] });
});

app.put('/api/guilds/:guildId/premium-roles', requireUser, requireGuildAccess, async function (req, res) {
  const tier = String(req.body.tier || '').trim();
  const roleId = String(req.body.role_id || '').trim();

  if (!tier) return bad(res, 400, 'Missing tier');
  if (!/^\d{15,25}$/.test(roleId)) return bad(res, 400, 'Invalid role id');

  const { data, error } = await db
    .from('premium_roles')
    .upsert({ guild_id: req.guildId, tier: tier, role_id: roleId }, { onConflict: 'guild_id,tier' })
    .select()
    .single();

  if (error) return bad(res, 500, error.message);
  res.json({ mapping: data });
});

// ------------------------------------------------------------
// STATUS BOARD
// ------------------------------------------------------------
const VALID_STATES = ['working', 'patched', 'maintenance', 'unknown'];

app.get('/api/guilds/:guildId/status', requireUser, requireGuildAccess, async function (req, res) {
  const { data, error } = await db
    .from('status_entries')
    .select('*')
    .eq('guild_id', req.guildId)
    .order('position', { ascending: true });

  if (error) return bad(res, 500, error.message);
  res.json({ entries: data || [] });
});

app.post('/api/guilds/:guildId/status', requireUser, requireGuildAccess, async function (req, res) {
  const title    = String(req.body.title    || '').trim().slice(0, 100);
  const gameName = String(req.body.game_name || '').trim().slice(0, 100) || null;
  const note     = String(req.body.note     || '').trim().slice(0, 300) || null;
  const state    = String(req.body.state    || 'working').trim();

  if (!title) return bad(res, 400, 'Missing title');
  if (title.length < 1)                          return bad(res, 400, 'Title is too short');
  if (VALID_STATES.indexOf(state) === -1)        return bad(res, 400, 'Invalid state');

  const { data, error } = await db
    .from('status_entries')
    .insert({
      guild_id:  req.guildId,
      title:     title,
      game_name: gameName,
      state:     state,
      note:      note,
      position:  Math.max(0, Math.min(9999, Number(req.body.position || 0)))
    })
    .select()
    .single();

  if (error) return bad(res, 500, error.message);

  await enqueueJob(req.guildId, 'refresh_status', {});
  res.json({ entry: data });
});

app.patch('/api/guilds/:guildId/status/:entryId', requireUser, requireGuildAccess, async function (req, res) {
  const patch = {};
  ['title', 'game_name', 'state', 'note', 'position'].forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(req.body, k)) patch[k] = req.body[k];
  });

  // Sanitize string fields so someone can't smuggle giant payloads via PATCH.
  if (patch.title)     patch.title     = String(patch.title).trim().slice(0, 100);
  if (patch.game_name) patch.game_name = String(patch.game_name).trim().slice(0, 100) || null;
  if (patch.note)      patch.note      = String(patch.note).trim().slice(0, 300) || null;
  if (patch.position !== undefined) patch.position = Math.max(0, Math.min(9999, Number(patch.position)));

  if (patch.title !== undefined && patch.title.length === 0) return bad(res, 400, 'Title cannot be empty');
  if (patch.state && VALID_STATES.indexOf(patch.state) === -1) return bad(res, 400, 'Invalid state');
  if (Object.keys(patch).length === 0) return bad(res, 400, 'Nothing to update');

  const { data, error } = await db
    .from('status_entries')
    .update(patch)
    .eq('id', req.params.entryId)
    .eq('guild_id', req.guildId)
    .select()
    .single();

  if (error) return bad(res, 500, error.message);

  await enqueueJob(req.guildId, 'refresh_status', {});
  res.json({ entry: data });
});

app.delete('/api/guilds/:guildId/status/:entryId', requireUser, requireGuildAccess, async function (req, res) {
  await db.from('status_entries').delete().eq('id', req.params.entryId).eq('guild_id', req.guildId);
  await enqueueJob(req.guildId, 'refresh_status', {});
  res.json({ ok: true });
});

// ------------------------------------------------------------
// TICKETS  -  post the Open a ticket panel from the dashboard
// Queues a job so the bot posts the panel in the chosen channel.
// ------------------------------------------------------------
app.post('/api/guilds/:guildId/ticket-panel', requireUser, requireGuildAccess, async function (req, res) {
  const channelId = String(req.body.channel_id || '').trim();
  if (!/^\d{15,25}$/.test(channelId)) return bad(res, 400, 'Pick a channel first');

  // make sure a category is configured, otherwise the panel is useless
  const { data: s } = await db
    .from('guild_settings')
    .select('ticket_category_id')
    .eq('guild_id', req.guildId)
    .maybeSingle();

  if (!s || !s.ticket_category_id) {
    return bad(res, 400, 'Set an open tickets category and save before posting the panel');
  }

  await enqueueJob(req.guildId, 'ticket_panel', {
    channel_id: channelId,
    title: req.body.title || null,
    message: req.body.message || null
  });

  await logAudit(req.guildId, req.dashUser.discord_id, 'ticket.panel.queued', { channel_id: channelId });
  res.json({ ok: true, queued: true });
});

// ------------------------------------------------------------
// ANNOUNCE  -  push an update embed to the updates channel
// ------------------------------------------------------------
app.post('/api/guilds/:guildId/announce', requireUser, requireGuildAccess, async function (req, res) {
  const title = String(req.body.title || '').trim();
  const body = String(req.body.body || '').trim();

  if (!title || !body) return bad(res, 400, 'Title and body are required');
  if (body.length > 3000) return bad(res, 400, 'Body is too long');

  await enqueueJob(req.guildId, 'send_message', {
    kind: 'announce',
    title: title,
    body: body,
    url: req.body.url || null
  });

  await logAudit(req.guildId, req.dashUser.discord_id, 'announce.queued', { title });
  res.json({ ok: true, queued: true });
});

// ------------------------------------------------------------
// RESET  -  erase every Helium record for this guild
// ------------------------------------------------------------
app.delete('/api/guilds/:guildId/reset', requireUser, requireGuildAccess, async function (req, res) {
  const gid = req.guildId;

  // 1. queue role removal for everyone currently holding premium
  const { data: holders } = await db
    .from('premium_members')
    .select('discord_id, tier')
    .eq('guild_id', gid)
    .eq('role_applied', true);

  const { data: maps } = await db
    .from('premium_roles')
    .select('tier, role_id')
    .eq('guild_id', gid);

  const roleFor = {};
  (maps || []).forEach(function (m) { roleFor[m.tier] = m.role_id; });

  let queued = 0;

  for (const h of holders || []) {
    if (!roleFor[h.tier]) continue;
    await enqueueJob(gid, 'remove_role', { discord_id: h.discord_id, role_id: roleFor[h.tier], tier: h.tier });
    queued++;
  }

  // 2. wipe the data. pending jobs survive so the removals above still run.
  await db.from('premium_code_redemptions').delete().eq('guild_id', gid);
  await db.from('premium_codes').delete().eq('guild_id', gid);
  await db.from('premium_members').delete().eq('guild_id', gid);
  await db.from('premium_roles').delete().eq('guild_id', gid);
  await db.from('status_entries').delete().eq('guild_id', gid);
  await db.from('tickets').delete().eq('guild_id', gid);
  await db.from('bot_jobs').delete().eq('guild_id', gid).neq('status', 'pending');
  await db.from('audit_log').delete().eq('guild_id', gid);

  // 3. settings back to factory defaults
  await db.from('guild_settings').delete().eq('guild_id', gid);
  await db.from('guild_settings').insert({ guild_id: gid });

  await logAudit(gid, req.dashUser.discord_id, 'server.reset', { roles_queued: queued });

  res.json({ ok: true, roles_queued: queued });
});

// ------------------------------------------------------------
// AUDIT LOG
// ------------------------------------------------------------
app.get('/api/guilds/:guildId/audit', requireUser, requireGuildAccess, async function (req, res) {
  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit  || '50', 10)));
  const offset = Math.max(0,              parseInt(req.query.offset || '0',  10));
  const action = req.query.action ? String(req.query.action).trim() : null;

  let q = db
    .from('audit_log')
    .select('*', { count: 'exact' })
    .eq('guild_id', req.guildId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (action) q = q.eq('action', action);

  const { data, error, count } = await q;
  if (error) return bad(res, 500, error.message);
  res.json({ entries: data || [], total: count || 0, limit, offset });
});

// ------------------------------------------------------------
// WEBHOOK from your own website
// Call this when someone buys premium on your site.
// Header: x-webhook-secret
// Body: { guild_id, discord_id, tier, days }
// ------------------------------------------------------------
app.post('/api/webhooks/purchase', async function (req, res) {
  if (!SITE_WEBHOOK_SECRET) return bad(res, 503, 'Webhook not configured');
  if (!timingSafeCompare(req.headers['x-webhook-secret'] || '', SITE_WEBHOOK_SECRET)) return bad(res, 401, 'Bad secret');

  const guildId = String(req.body.guild_id || '').trim();
  const discordId = String(req.body.discord_id || '').trim();
  const tier = String(req.body.tier || 'basic').trim();
  const days = Number(req.body.days || 30);

  if (!/^\d{15,25}$/.test(guildId)) return bad(res, 400, 'Invalid guild id');
  if (!/^\d{15,25}$/.test(discordId)) return bad(res, 400, 'Invalid discord id');
  if (!(days > 0 && days <= 3650)) return bad(res, 400, 'Invalid days');

  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await db.from('premium_members').upsert(
    {
      guild_id: guildId,
      discord_id: discordId,
      tier: tier,
      source: 'website',
      expires_at: expires,
      role_applied: false
    },
    { onConflict: 'guild_id,discord_id,tier' }
  );

  if (error) return bad(res, 500, error.message);

  await logAudit(guildId, discordId, 'premium.purchase', { tier, days });
  res.json({ ok: true });
});

// ------------------------------------------------------------
// fallbacks
// ------------------------------------------------------------
app.use(function (req, res) {
  res.status(404).json({ error: 'Not found' });
});

app.use(function (err, req, res, next) {
  console.error('Unhandled:', err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, function () {
  console.log('API listening on port ' + PORT);
});
