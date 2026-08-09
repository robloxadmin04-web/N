// ============================================================
// bot/index.js
// Discord bot process. Runs alongside the API in one service.
//
// UPDATED for tickets: added GuildMessages + MessageContent
// intents (needed to read history for transcripts) and the
// Channel/Message partials. Everything else is unchanged.
//
// IMPORTANT: also enable MESSAGE CONTENT INTENT in the Discord
// Developer Portal -> your app -> Bot -> Privileged Gateway
// Intents, and re-invite the bot with the Manage Channels
// permission so it can create/move/delete ticket channels.
// ============================================================
'use strict';

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder
} = require('discord.js');

const { createClient } = require('@supabase/supabase-js');
const {
  startJobLoop,
  startPremiumSync,
  startReconcile,
  renderStatusBoard
} = require('./jobs');

const {
  handleInteraction,
  registerCommands
} = require('./commands');

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!DISCORD_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing DISCORD_BOT_TOKEN, SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
  );
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

// How long to wait before handing a new member the auto role.
const AUTOROLE_DELAY_MS = 10000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.GuildMember,
    Partials.Channel,
    Partials.Message
  ]
});

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------

async function upsertGuild(guild) {
  await db.from('guilds').upsert(
    {
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      owner_discord_id: guild.ownerId,
      member_count: guild.memberCount || 0,
      active: true
    },
    { onConflict: 'id' }
  );

  await db
    .from('guild_settings')
    .upsert(
      { guild_id: guild.id },
      {
        onConflict: 'guild_id',
        ignoreDuplicates: true
      }
    );
}

async function getSettings(guildId) {
  const { data } = await db
    .from('guild_settings')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();

  return data;
}

// ------------------------------------------------------------
// FIXED:
// {user} now uses the member's Discord Display Name
// instead of showing <@DISCORD_ID>
//
// Available placeholders:
// {user}     = Display Name
// {username} = Discord username
// {server}   = Server name
// {count}    = Member count
// ------------------------------------------------------------

function fillTemplate(text, member) {
  const displayName =
    member.displayName ||
    (member.user && member.user.displayName) ||
    (member.user && member.user.username) ||
    'Unknown User';

  const username =
    (member.user && member.user.username) ||
    displayName;

  return String(text || '')
    .split('{user}').join(displayName)
    .split('{username}').join(username)
    .split('{server}').join(member.guild.name)
    .split('{count}').join(String(member.guild.memberCount));
}

async function sendLog(guild, text) {
  const s = await getSettings(guild.id);

  if (!s || !s.log_channel_id) return;

  const channel = guild.channels.cache.get(s.log_channel_id);

  if (!channel) return;

  channel.send({ content: text }).catch(function () {});
}

// ------------------------------------------------------------
// ready
// ------------------------------------------------------------

client.once(Events.ClientReady, async function (c) {
  console.log(
    'Bot online as ' +
      c.user.tag +
      ' in ' +
      c.guilds.cache.size +
      ' guilds'
  );

  for (const guild of c.guilds.cache.values()) {
    try {
      await upsertGuild(guild);
      await registerCommands(guild);
    } catch (e) {
      console.error(
        'Startup failed for ' +
          guild.id +
          ': ' +
          e.message
      );
    }
  }

  startJobLoop(client, db);
  startPremiumSync(client, db);
  startReconcile(client, db);
});

// ------------------------------------------------------------
// slash commands
// ------------------------------------------------------------

client.on(Events.InteractionCreate, function (interaction) {
  handleInteraction(interaction, db).catch(function (e) {
    console.error('Interaction error: ' + e.message);
  });
});

// ------------------------------------------------------------
// joined a new server
// ------------------------------------------------------------

client.on(Events.GuildCreate, async function (guild) {
  console.log(
    'Joined guild ' +
      guild.name +
      ' (' +
      guild.id +
      ')'
  );

  await upsertGuild(guild);
  await registerCommands(guild);
});

// ------------------------------------------------------------
// removed from a server
// ------------------------------------------------------------

client.on(Events.GuildDelete, async function (guild) {
  console.log('Left guild ' + guild.id);

  await db
    .from('guilds')
    .update({ active: false })
    .eq('id', guild.id);
});

// ------------------------------------------------------------
// member joined
// ------------------------------------------------------------

client.on(Events.GuildMemberAdd, async function (member) {
  try {
    const s = await getSettings(member.guild.id);

    if (!s) return;

    // raid protection: hold very new accounts
    if (
      s.raid_protection &&
      s.min_account_age_days > 0
    ) {
      const ageDays =
        (Date.now() - member.user.createdTimestamp) /
        86400000;

      if (ageDays < s.min_account_age_days) {
        await sendLog(
          member.guild,
          'Held new account ' +
            member.user.tag +
            ' (age ' +
            ageDays.toFixed(1) +
            ' days)'
        );

        return;
      }
    }

    // autorole, on a short delay
    // setTimeout instead of await so the welcome message below
    // still posts the moment they join
    if (
      s.autorole_enabled &&
      s.autorole_id
    ) {
      const role =
        member.guild.roles.cache.get(
          s.autorole_id
        );

      if (role) {
        setTimeout(function () {
          member.roles
            .add(role)
            .catch(function (e) {
              console.error(
                'Autorole failed for ' +
                  member.user.tag +
                  ': ' +
                  e.message
              );
            });
        }, AUTOROLE_DELAY_MS);
      }
    }

    // restore premium role if still paid up
    const { data: prem } = await db
      .from('premium_members')
      .select('tier, expires_at')
      .eq('guild_id', member.guild.id)
      .eq('discord_id', member.id)
      .maybeSingle();

    if (
      prem &&
      (
        !prem.expires_at ||
        new Date(prem.expires_at) > new Date()
      )
    ) {
      const { data: map } = await db
        .from('premium_roles')
        .select('role_id')
        .eq('guild_id', member.guild.id)
        .eq('tier', prem.tier)
        .maybeSingle();

      if (map) {
        const role =
          member.guild.roles.cache.get(
            map.role_id
          );

        if (role) {
          await member.roles
            .add(role)
            .catch(function () {});
        }
      }
    }

    // --------------------------------------------------------
    // welcome message
    // --------------------------------------------------------

    if (s.welcome_enabled && s.welcome_channel_id) {
      const channel = member.guild.channels.cache.get(
        s.welcome_channel_id
      );

      if (channel) {
        const welcomeMessage = fillTemplate(
          s.welcome_message,
          member
        );

        const embed = new EmbedBuilder()
          .setDescription(welcomeMessage)
          .setColor(0xffffff)
          .setThumbnail(member.user.displayAvatarURL())
          .setFooter({
            text: 'Member ' + member.guild.memberCount
          });

        channel.send({
          embeds: [embed]
        }).catch(function (e) {
          console.error(
            'Welcome message failed for ' +
              member.user.tag +
              ': ' +
              e.message
          );
        });
      }
    }

    await db
      .from('guilds')
      .update({
        member_count:
          member.guild.memberCount
      })
      .eq('id', member.guild.id);

  } catch (e) {
    console.error(
      'GuildMemberAdd failed: ' +
        e.message
    );
  }
});

// ------------------------------------------------------------
// member left
// ------------------------------------------------------------

client.on(
  Events.GuildMemberRemove,
  async function (member) {
    await db
      .from('guilds')
      .update({
        member_count:
          member.guild.memberCount
      })
      .eq('id', member.guild.id);
  }
);

// ------------------------------------------------------------
// shutdown
// ------------------------------------------------------------

process.on('SIGTERM', function () {
  console.log(
    'SIGTERM received, closing'
  );

  client.destroy();
  process.exit(0);
});

process.on(
  'unhandledRejection',
  function (reason) {
    console.error(
      'Unhandled rejection:',
      reason
    );
  }
);

client.login(DISCORD_BOT_TOKEN);

module.exports = {
  client,
  db,
  renderStatusBoard
};
