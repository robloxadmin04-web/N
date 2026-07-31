// ============================================================
// bot/jobs.js  -  job queue worker + premium role sync
// Imported by index.js
// ============================================================
'use strict';

const { EmbedBuilder } = require('discord.js');

const JOB_INTERVAL_MS = 5000;
const PREMIUM_INTERVAL_MS = 5 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;

const STATE_LABEL = {
  working: 'WORKING',
  patched: 'PATCHED',
  maintenance: 'MAINTENANCE',
  unknown: 'UNKNOWN'
};

const STATE_COLOR = {
  working: 0x2ecc71,
  patched: 0xe74c3c,
  maintenance: 0xf1c40f,
  unknown: 0x95a5a6
};

// ------------------------------------------------------------
// status board rendering
// ------------------------------------------------------------
async function renderStatusBoard(client, db, guildId) {
  const { data: settings } = await db
    .from('guild_settings')
    .select('status_channel_id, status_message_id')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (!settings || !settings.status_channel_id) return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const channel = guild.channels.cache.get(settings.status_channel_id);
  if (!channel) return;

  const { data: entries } = await db
    .from('status_entries')
    .select('*')
    .eq('guild_id', guildId)
    .order('position', { ascending: true });

  const list = entries || [];

  let description = 'No entries yet.';
  if (list.length > 0) {
    description = list
      .map(function (e) {
        const label = STATE_LABEL[e.state] || 'UNKNOWN';
        const game = e.game_name ? ' - ' + e.game_name : '';
        const note = e.note ? '\n     ' + e.note : '';
        return '[' + label + '] ' + e.title + game + note;
      })
      .join('\n');
  }

  const working = list.filter(function (e) { return e.state === 'working'; }).length;

  const embed = new EmbedBuilder()
    .setTitle('Status Board')
    .setDescription('```\n' + description.slice(0, 3800) + '\n```')
    .setColor(working > 0 ? 0x2ecc71 : 0xe74c3c)
    .setFooter({ text: working + ' of ' + list.length + ' working' })
    .setTimestamp(new Date());

  if (settings.status_message_id) {
    try {
      const msg = await channel.messages.fetch(settings.status_message_id);
      await msg.edit({ embeds: [embed] });
      return;
    } catch (e) {
      // message was deleted, fall through and post a new one
    }
  }

  const sent = await channel.send({ embeds: [embed] });
  await db
    .from('guild_settings')
    .update({ status_message_id: sent.id })
    .eq('guild_id', guildId);
}

// ------------------------------------------------------------
// single job handlers
// ------------------------------------------------------------
async function runJob(client, db, job) {
  const guild = client.guilds.cache.get(job.guild_id);
  if (!guild) throw new Error('Bot is not in guild ' + job.guild_id);

  const p = job.payload || {};

  if (job.type === 'add_role' || job.type === 'remove_role') {
    const member = await guild.members.fetch(p.discord_id).catch(function () { return null; });
    if (!member) throw new Error('Member not in guild');

    const role = guild.roles.cache.get(p.role_id);
    if (!role) throw new Error('Role not found');

    const applied = job.type === 'add_role';

    if (applied) {
      await member.roles.add(role);
    } else {
      await member.roles.remove(role);
    }

    // Only touch the row for this tier. A member can hold several.
    let mark = db
      .from('premium_members')
      .update({ role_applied: applied })
      .eq('guild_id', job.guild_id)
      .eq('discord_id', p.discord_id);

    if (p.tier) mark = mark.eq('tier', p.tier);
    await mark;
    return;
  }

  if (job.type === 'send_message') {
    const { data: settings } = await db
      .from('guild_settings')
      .select('updates_channel_id')
      .eq('guild_id', job.guild_id)
      .maybeSingle();

    const channelId = p.channel_id || (settings && settings.updates_channel_id);
    if (!channelId) throw new Error('No target channel configured');

    const channel = guild.channels.cache.get(channelId);
    if (!channel) throw new Error('Channel not found');

    if (p.kind === 'announce') {
      const embed = new EmbedBuilder()
        .setTitle(String(p.title).slice(0, 250))
        .setDescription(String(p.body).slice(0, 4000))
        .setColor(0x5865f2)
        .setTimestamp(new Date());

      if (p.url) embed.setURL(p.url);
      await channel.send({ embeds: [embed] });
    } else {
      await channel.send({ content: String(p.body || '').slice(0, 1900) });
    }
    return;
  }

  if (job.type === 'refresh_status') {
    await renderStatusBoard(client, db, job.guild_id);
    return;
  }

  throw new Error('Unknown job type: ' + job.type);
}

// ------------------------------------------------------------
// job loop
// ------------------------------------------------------------
function startJobLoop(client, db) {
  let busy = false;

  setInterval(async function () {
    if (busy) return;
    busy = true;

    try {
      const { data: jobs, error } = await db
        .from('bot_jobs')
        .select('*')
        .eq('status', 'pending')
        .lt('attempts', MAX_ATTEMPTS)
        .order('created_at', { ascending: true })
        .limit(10);

      if (error) throw new Error(error.message);

      for (const job of jobs || []) {
        try {
          await runJob(client, db, job);
          await db
            .from('bot_jobs')
            .update({ status: 'done', processed_at: new Date().toISOString(), error: null })
            .eq('id', job.id);
        } catch (e) {
          const attempts = job.attempts + 1;
          const failed = attempts >= MAX_ATTEMPTS;
          await db
            .from('bot_jobs')
            .update({
              attempts: attempts,
              status: failed ? 'failed' : 'pending',
              error: e.message.slice(0, 500),
              processed_at: failed ? new Date().toISOString() : null
            })
            .eq('id', job.id);
          console.error('Job ' + job.id + ' (' + job.type + ') failed: ' + e.message);
        }
      }
    } catch (e) {
      console.error('Job loop error: ' + e.message);
    }

    busy = false;
  }, JOB_INTERVAL_MS);

  console.log('Job loop started');
}

// ------------------------------------------------------------
// premium sync: grant roles to paid members, strip expired ones
// ------------------------------------------------------------
function startPremiumSync(client, db) {
  async function sync() {
    try {
      const nowIso = new Date().toISOString();

      // expired but still holding the role
      const { data: expired } = await db
        .from('premium_members')
        .select('guild_id, discord_id, tier')
        .eq('role_applied', true)
        .not('expires_at', 'is', null)
        .lt('expires_at', nowIso)
        .limit(200);

      for (const m of expired || []) {
        const { data: map } = await db
          .from('premium_roles')
          .select('role_id')
          .eq('guild_id', m.guild_id)
          .eq('tier', m.tier)
          .maybeSingle();

        if (!map) continue;

        await db.from('bot_jobs').insert({
          guild_id: m.guild_id,
          type: 'remove_role',
          payload: { discord_id: m.discord_id, role_id: map.role_id, tier: m.tier }
        });
      }

      // paid but role not applied yet
      const { data: pending } = await db
        .from('premium_members')
        .select('guild_id, discord_id, tier, expires_at')
        .eq('role_applied', false)
        .limit(200);

      for (const m of pending || []) {
        if (m.expires_at && new Date(m.expires_at) <= new Date()) continue;

        const { data: map } = await db
          .from('premium_roles')
          .select('role_id')
          .eq('guild_id', m.guild_id)
          .eq('tier', m.tier)
          .maybeSingle();

        if (!map) continue;

        await db.from('bot_jobs').insert({
          guild_id: m.guild_id,
          type: 'add_role',
          payload: { discord_id: m.discord_id, role_id: map.role_id, tier: m.tier }
        });
      }
    } catch (e) {
      console.error('Premium sync error: ' + e.message);
    }
  }

  setTimeout(sync, 15000);
  setInterval(sync, PREMIUM_INTERVAL_MS);

  console.log('Premium sync started');
}

// ------------------------------------------------------------
// reconcile: the safety net.
//
// The sync above only reacts to rows it believes it applied.
// This pass ignores what the database thinks and looks at who
// actually holds each premium role in Discord. Anyone holding a
// role without a live membership loses it. That covers manual
// database edits, failed jobs, downtime and roles handed out by
// hand.
// ------------------------------------------------------------
// ------------------------------------------------------------
// autorole catch up
//
// GuildMemberAdd only fires while the bot is connected. If it was
// asleep or restarting when someone joined, that member never got
// the role and nothing would ever notice. This pass hands the
// autorole to anyone who is missing it.
// ------------------------------------------------------------
async function reconcileAutorole(client, db, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const { data: s } = await db
    .from('guild_settings')
    .select('autorole_enabled, autorole_id, raid_protection, min_account_age_days')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (!s || !s.autorole_enabled || !s.autorole_id) return;

  const role = guild.roles.cache.get(s.autorole_id);
  if (!role) {
    console.error('Autorole catch up: role ' + s.autorole_id + ' no longer exists');
    return;
  }

  await guild.members.fetch().catch(function () {});

  // Respect raid protection so held accounts stay held.
  const holdDays = s.raid_protection ? (s.min_account_age_days || 0) : 0;
  let given = 0;

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    if (member.roles.cache.has(role.id)) continue;

    if (holdDays > 0) {
      const ageDays = (Date.now() - member.user.createdTimestamp) / 86400000;
      if (ageDays < holdDays) continue;
    }

    try {
      await member.roles.add(role);
      given++;
      console.log('Autorole catch up: gave ' + role.name + ' to ' + member.user.tag);
    } catch (e) {
      console.error('Autorole catch up failed on ' + member.user.tag + ': ' + e.message);
      break;
    }
  }

  if (given) console.log('Autorole catch up: ' + given + ' member(s) in ' + guild.name);
}

async function reconcileGuild(client, db, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const { data: maps } = await db
    .from('premium_roles')
    .select('tier, role_id')
    .eq('guild_id', guildId);

  if (!maps || maps.length === 0) return;

  const { data: rows } = await db
    .from('premium_members')
    .select('discord_id, tier, expires_at')
    .eq('guild_id', guildId);

  const now = Date.now();
  const live = new Set();

  (rows || []).forEach(function (r) {
    const active = !r.expires_at || new Date(r.expires_at).getTime() > now;
    if (active) live.add(r.discord_id + '|' + r.tier);
  });

  // role.members is only accurate once the member list is loaded
  await guild.members.fetch().catch(function () {});

  for (const map of maps) {
    const role = guild.roles.cache.get(map.role_id);
    if (!role) continue;

    for (const member of role.members.values()) {
      if (member.user.bot) continue;
      if (live.has(member.id + '|' + map.tier)) continue;

      try {
        await member.roles.remove(role);
        console.log('Reconcile: took ' + role.name + ' from ' + member.user.tag);
      } catch (e) {
        console.error('Reconcile could not remove ' + role.name + ' from ' + member.user.tag + ': ' + e.message);
        continue;
      }

      await db
        .from('premium_members')
        .update({ role_applied: false })
        .eq('guild_id', guildId)
        .eq('discord_id', member.id)
        .eq('tier', map.tier);
    }
  }
}

function startReconcile(client, db) {
  async function run() {
    for (const guild of client.guilds.cache.values()) {
      try {
        await reconcileGuild(client, db, guild.id);
        await reconcileAutorole(client, db, guild.id);
      } catch (e) {
        console.error('Reconcile failed for ' + guild.id + ': ' + e.message);
      }
    }
  }

  setTimeout(run, 30000);
  setInterval(run, RECONCILE_INTERVAL_MS);

  console.log('Reconcile started');
}

module.exports = { startJobLoop, startPremiumSync, startReconcile, renderStatusBoard };
