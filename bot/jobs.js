// ============================================================
// bot/jobs.js  -  job queue worker + premium role sync
// Imported by index.js
// ============================================================
'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');

const JOB_INTERVAL_MS = 5000;
const PREMIUM_INTERVAL_MS = 5 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;

// Built-in ticket reasons. Must match bot/tickets.js.
const REASONS = [
  { value: 'support',  label: 'General support', description: 'Questions or help with the server' },
  { value: 'purchase', label: 'Purchase or premium', description: 'Buying, codes, roles or billing' },
  { value: 'report',   label: 'Report a problem', description: 'Report a user, bug or issue' },
  { value: 'other',    label: 'Something else', description: 'Anything not covered above' }
];

const STATE_LABEL = {
  working:     'WORKING',
  patched:     'PATCHED',
  maintenance: 'MAINTENANCE',
  unknown:     'UNKNOWN'
};

const STATE_EMOJI = {
  working:     '🟢',
  patched:     '🔴',
  maintenance: '🟡',
  unknown:     '⚫'
};

const STATE_COLOR = {
  working:     0x2ecc71,
  patched:     0xe74c3c,
  maintenance: 0xf1c40f,
  unknown:     0x95a5a6
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

  // ── count per state ─────────────────────────────────────────
  const counts = { working: 0, patched: 0, maintenance: 0, unknown: 0 };
  list.forEach(function (e) {
    const s = e.state in counts ? e.state : 'unknown';
    counts[s]++;
  });

  const working = counts.working;

  // ── overall status line ──────────────────────────────────────
  let overallLine;
  if (list.length === 0) {
    overallLine = '⚫  No entries yet.';
  } else if (counts.patched > 0 || counts.maintenance > 0) {
    overallLine = '🔴  **Some exploits are down**';
  } else {
    overallLine = '🟢  **All exploits operational**';
  }

  // ── per-entry lines ──────────────────────────────────────────
  let description = overallLine + '\n\u200b';
  if (list.length > 0) {
    const entryLines = list.map(function (e) {
      const emoji = STATE_EMOJI[e.state] || '⚫';
      const label = STATE_LABEL[e.state] || 'UNKNOWN';
      const game  = e.game_name ? ' · ' + e.game_name : '';
      const note  = e.note      ? '\n> -# ' + e.note  : '';
      return emoji + ' **' + e.title + '**' + game + '  `' + label + '`' + note;
    });
    description += '\n' + entryLines.join('\n\n');
  }

  // ── summary footer text ──────────────────────────────────────
  const parts = [];
  if (counts.working     > 0) parts.push(counts.working     + ' working');
  if (counts.patched     > 0) parts.push(counts.patched     + ' patched');
  if (counts.maintenance > 0) parts.push(counts.maintenance + ' maintenance');
  if (counts.unknown     > 0) parts.push(counts.unknown     + ' unknown');
  const footerText = parts.length ? parts.join(' · ') : 'No entries';

  // ── embed color: green = all working, yellow = maintenance, red = patched
  let boardColor = 0x2ecc71;
  if (counts.patched     > 0)                       boardColor = 0xe74c3c;
  if (counts.maintenance > 0 && counts.patched === 0) boardColor = 0xf1c40f;
  if (list.length        === 0)                     boardColor = 0x95a5a6;

  const embed = new EmbedBuilder()
    .setTitle('📋  Exploit Status Board')
    .setDescription(description.slice(0, 4000))
    .setColor(boardColor)
    .setFooter({ text: footerText })
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

  if (job.type === 'ticket_panel') {
    const { data: s } = await db
      .from('guild_settings')
      .select('ticket_category_id')
      .eq('guild_id', job.guild_id)
      .maybeSingle();

    if (!s || !s.ticket_category_id) throw new Error('No ticket category configured');

    const channel = guild.channels.cache.get(p.channel_id);
    if (!channel) throw new Error('Panel channel not found');

    const embed = new EmbedBuilder()
      .setTitle(String(p.title || 'Need help?').slice(0, 250))
      .setDescription(String(p.message || 'Choose a reason below to open a private ticket. Only you and the staff team can see it.').slice(0, 2000))
      .setColor(0xffffff)
      .setFooter({ text: 'One ticket per person at a time' });

    const menu = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('ticket:pick')
        .setPlaceholder('Choose a reason to open a ticket')
        .addOptions(REASONS.map(function (r) {
          return { label: r.label, description: r.description, value: r.value };
        }))
    );

    await channel.send({ embeds: [embed], components: [menu] });
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

          // Alert the log channel when a job permanently fails so
          // the server owner knows without having to check the DB.
          if (failed) {
            try {
              const { data: s } = await db
                .from('guild_settings')
                .select('log_channel_id')
                .eq('guild_id', job.guild_id)
                .maybeSingle();

              if (s && s.log_channel_id) {
                const guild = client.guilds.cache.get(job.guild_id);
                const logCh = guild && guild.channels.cache.get(s.log_channel_id);
                if (logCh) {
                  const alertEmbed = new EmbedBuilder()
                    .setTitle('⚠️ Background Job Failed')
                    .setColor(0xe74c3c)
                    .setDescription(
                      '**Type:** `' + job.type + '`\n' +
                      '**Job ID:** `' + job.id + '`\n' +
                      '**Error:** ' + e.message.slice(0, 300)
                    )
                    .setFooter({ text: 'Check your bot settings or role hierarchy.' })
                    .setTimestamp(new Date());
                  logCh.send({ embeds: [alertEmbed] }).catch(function () {});
                }
              }
            } catch (alertErr) {
              console.error('Failed to send job failure alert: ' + alertErr.message);
            }
          }
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

  if (!s) {
    console.log('Autorole catch up: no settings row for ' + guild.name);
    return;
  }

  if (!s.autorole_enabled) {
    console.log('Autorole catch up: turned OFF in ' + guild.name);
    return;
  }

  if (!s.autorole_id) {
    console.log('Autorole catch up: enabled but no role picked in ' + guild.name);
    return;
  }

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

      if (ageDays < holdDays) {
        console.log(
          'Autorole catch up: holding ' + member.user.tag +
          ' (account is ' + ageDays.toFixed(1) + ' days old, minimum is ' + holdDays + ')'
        );
        continue;
      }
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

  console.log(
    'Autorole catch up: ' + guild.name + ' done, ' + given + ' given, role ' + role.name
  );
}

async function reconcileGuild(client, db, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const { data: maps } = await db
    .from('premium_roles')
    .select('tier, role_id')
    .eq('guild_id', guildId);

  if (!maps || maps.length === 0) return;

  // The auto role belongs to everyone, not to a paid tier. If a
  // mapping ever points at it, this pass would strip it from every
  // member who has not bought that tier. Never touch it.
  const { data: cfg } = await db
    .from('guild_settings')
    .select('autorole_id, autorole_enabled')
    .eq('guild_id', guildId)
    .maybeSingle();

  const protectedRoleId = cfg && cfg.autorole_enabled ? cfg.autorole_id : null;

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
    if (protectedRoleId && map.role_id === protectedRoleId) {
      console.log('Reconcile: skipping tier ' + map.tier + ', it points at the auto role');
      continue;
    }

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

// ------------------------------------------------------------
// ticket role expiry
//
// Runs every 5 minutes. Checks ticket_role_grants for rows
// where expires_at has passed, removes the role from the member,
// DMs them, then deletes the grant row.
// ------------------------------------------------------------
const TICKET_ROLE_INTERVAL_MS = 5 * 60 * 1000;

function startTicketRoleExpiry(client, db) {
  async function run() {
    try {
      const nowIso = new Date().toISOString();

      const { data: expired } = await db
        .from('ticket_role_grants')
        .select('*')
        .lt('expires_at', nowIso)
        .limit(100);

      for (const grant of expired || []) {
        try {
          const guild = client.guilds.cache.get(grant.guild_id);
          if (!guild) continue;

          const member = await guild.members.fetch(grant.discord_id).catch(() => null);
          const role   = guild.roles.cache.get(grant.role_id);

          // Remove the role if both member and role still exist.
          if (member && role) {
            await member.roles.remove(role).catch(function (e) {
              console.error(
                'Ticket role expiry: could not remove ' + role.name +
                ' from ' + member.user.tag + ': ' + e.message
              );
            });
          }

          // DM the user.
          const roleName = role ? role.name : 'a role';
          const guildName = guild.name;

          if (member) {
            await member.user.send(
              '⏰ Your **' + roleName + '** role in **' + guildName +
              '** has expired and has been removed.'
            ).catch(function () {
              // DMs may be closed — ignore silently.
            });
          }

          // Delete the grant row regardless of whether the removal succeeded.
          await db
            .from('ticket_role_grants')
            .delete()
            .eq('guild_id', grant.guild_id)
            .eq('discord_id', grant.discord_id)
            .eq('role_id', grant.role_id);

          console.log(
            'Ticket role expiry: removed ' + roleName +
            ' from ' + grant.discord_id + ' in ' + guildName
          );
        } catch (e) {
          console.error('Ticket role expiry error on grant ' + grant.id + ': ' + e.message);
        }
      }
    } catch (e) {
      console.error('Ticket role expiry loop error: ' + e.message);
    }
  }

  setTimeout(run, 60000); // first run after 1 minute
  setInterval(run, TICKET_ROLE_INTERVAL_MS);

  console.log('Ticket role expiry started');
}

module.exports = { startJobLoop, startPremiumSync, startReconcile, startTicketRoleExpiry, renderStatusBoard };
