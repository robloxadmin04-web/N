// ============================================================
// bot/tickets.js
// Ticket system: an "Open a ticket" panel, per-ticket channels
// with Claim + Close buttons, a .txt transcript on close, and
// archive-or-delete handling.
//
// Matches the style of commands.js: plain functions, the panel()
// embed helper, ephemeral replies, audit_log inserts.
//
// Settings read from guild_settings (add these columns, see SQL):
//   ticket_category_id       - where OPEN tickets are created
//   ticket_archive_id        - where CLOSED tickets are moved
//   ticket_staff_role_id     - role that can see + claim + close
//   ticket_log_channel_id    - where transcripts are posted
// ============================================================
'use strict';

const {
  EmbedBuilder,
  PermissionsBitField,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  AttachmentBuilder
} = require('discord.js');

// customId namespace for every ticket button
const TID = {
  open: 'ticket:open',
  claim: 'ticket:claim',
  close: 'ticket:close',      // archive on close
  delete: 'ticket:delete'     // hard delete
};

// ------------------------------------------------------------
// small local helpers (kept independent of commands.js so this
// file can be required on its own)
// ------------------------------------------------------------
function panel(title, lines) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.filter(Boolean).join('\n'))
    .setColor(0xffffff)
    .setTimestamp(new Date());
}

async function reply(interaction, embed) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ embeds: [embed] });
  }
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

function isStaff(interaction) {
  if (!interaction.memberPermissions) return false;
  return interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild);
}

async function getSettings(db, guildId) {
  const { data } = await db
    .from('guild_settings')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();
  return data || {};
}

// A member counts as ticket staff if they have Manage Server OR
// they hold the configured ticket_staff_role_id.
async function isTicketStaff(interaction, settings) {
  if (isStaff(interaction)) return true;
  if (!settings.ticket_staff_role_id) return false;

  const member = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  return Boolean(member && member.roles.cache.has(settings.ticket_staff_role_id));
}

// ------------------------------------------------------------
// /ticketpanel  -  posts the public "Open a ticket" button
// ------------------------------------------------------------
async function handleTicketPanel(interaction, db) {
  const target = interaction.options.getChannel('channel') || interaction.channel;
  const title = interaction.options.getString('title') || 'Need help?';
  const message = interaction.options.getString('message') ||
    'Press the button below to open a private ticket. Only you and the staff team can see it.';

  if (!target || typeof target.send !== 'function') {
    return reply(interaction, panel('Cannot post there', ['Pick a normal text channel.']));
  }

  const settings = await getSettings(db, interaction.guildId);

  if (!settings.ticket_category_id) {
    return reply(interaction, panel('Set up tickets first', [
      'No ticket category is configured yet.',
      'Run /ticketconfig and set at least the category before posting a panel.'
    ]));
  }

  const board = new EmbedBuilder()
    .setTitle(title)
    .setDescription(message)
    .setColor(0xffffff)
    .setFooter({ text: 'One ticket per person at a time' });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TID.open)
      .setLabel('Open a ticket')
      .setStyle(ButtonStyle.Secondary)
  );

  try {
    await target.send({ embeds: [board], components: [buttons] });
  } catch (e) {
    return reply(interaction, panel('Could not post the panel', [
      'I need View Channel, Send Messages and Embed Links in that channel.'
    ]));
  }

  await db.from('audit_log').insert({
    guild_id: interaction.guildId,
    actor_discord_id: interaction.user.id,
    action: 'ticket.panel',
    detail: { channel_id: target.id }
  });

  return reply(interaction, panel('Panel posted', [
    'It stays working forever, even after the bot restarts.',
    'Pin it so members can always find it.'
  ]));
}

// ------------------------------------------------------------
// /ticketconfig  -  staff set category, archive, role, log
// ------------------------------------------------------------
async function handleTicketConfig(interaction, db) {
  const category = interaction.options.getChannel('category');
  const archive = interaction.options.getChannel('archive');
  const role = interaction.options.getRole('staff_role');
  const log = interaction.options.getChannel('log_channel');

  const patch = { guild_id: interaction.guildId };

  if (category) {
    if (category.type !== ChannelType.GuildCategory) {
      return reply(interaction, panel('Wrong channel type', ['category must be a category, not a text channel.']));
    }
    patch.ticket_category_id = category.id;
  }

  if (archive) {
    if (archive.type !== ChannelType.GuildCategory) {
      return reply(interaction, panel('Wrong channel type', ['archive must be a category, not a text channel.']));
    }
    patch.ticket_archive_id = archive.id;
  }

  if (role) patch.ticket_staff_role_id = role.id;
  if (log) patch.ticket_log_channel_id = log.id;

  if (Object.keys(patch).length === 1) {
    const s = await getSettings(db, interaction.guildId);
    return reply(interaction, panel('Current ticket settings', [
      'Category: ' + (s.ticket_category_id ? '<#' + s.ticket_category_id + '>' : 'not set'),
      'Archive: ' + (s.ticket_archive_id ? '<#' + s.ticket_archive_id + '>' : 'not set (deletes on close)'),
      'Staff role: ' + (s.ticket_staff_role_id ? '<@&' + s.ticket_staff_role_id + '>' : 'Manage Server only'),
      'Log channel: ' + (s.ticket_log_channel_id ? '<#' + s.ticket_log_channel_id + '>' : 'not set (no transcripts posted)'),
      '',
      'Pass any of: category, archive, staff_role, log_channel to change them.'
    ]));
  }

  await db
    .from('guild_settings')
    .upsert(patch, { onConflict: 'guild_id' });

  await db.from('audit_log').insert({
    guild_id: interaction.guildId,
    actor_discord_id: interaction.user.id,
    action: 'ticket.config',
    detail: patch
  });

  return reply(interaction, panel('Ticket settings saved', [
    category ? 'Category set to ' + category.name : '',
    archive ? 'Archive set to ' + archive.name : '',
    role ? 'Staff role set to ' + role.name : '',
    log ? 'Log channel set to ' + log.name : '',
    '',
    'Post the public button with /ticketpanel.'
  ]));
}

// ------------------------------------------------------------
// Open a ticket (button on the public panel)
// ------------------------------------------------------------
async function openTicket(interaction, db) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const settings = await getSettings(db, interaction.guildId);

  if (!settings.ticket_category_id) {
    return reply(interaction, panel('Tickets are not set up', [
      'Staff need to run /ticketconfig first.'
    ]));
  }

  // one open ticket per person
  const { data: already } = await db
    .from('tickets')
    .select('channel_id')
    .eq('guild_id', interaction.guildId)
    .eq('opener_id', interaction.user.id)
    .eq('status', 'open')
    .maybeSingle();

  if (already) {
    const still = interaction.guild.channels.cache.get(already.channel_id);
    if (still) {
      return reply(interaction, panel('You already have a ticket', [
        'Head to ' + still.toString() + ' to continue.'
      ]));
    }
    // channel was deleted manually, clear the stale row
    await db.from('tickets').update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('guild_id', interaction.guildId)
      .eq('channel_id', already.channel_id);
  }

  const overwrites = [
    { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles
      ]
    }
  ];

  if (settings.ticket_staff_role_id) {
    overwrites.push({
      id: settings.ticket_staff_role_id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles
      ]
    });
  }

  let channel;
  try {
    channel = await interaction.guild.channels.create({
      name: 'ticket-' + interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20),
      type: ChannelType.GuildText,
      parent: settings.ticket_category_id,
      permissionOverwrites: overwrites
    });
  } catch (e) {
    return reply(interaction, panel('Could not create the ticket', [
      'Give me the Manage Channels permission and make sure the category still exists.'
    ]));
  }

  await db.from('tickets').insert({
    guild_id: interaction.guildId,
    channel_id: channel.id,
    opener_id: interaction.user.id,
    status: 'open'
  });

  const welcome = new EmbedBuilder()
    .setTitle('Ticket opened')
    .setDescription('Thanks <@' + interaction.user.id + '>, staff will be with you shortly. Describe your issue below.')
    .setColor(0xffffff);

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(TID.claim).setLabel('Claim').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(TID.close).setLabel('Close').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(TID.delete).setLabel('Delete').setStyle(ButtonStyle.Danger)
  );

  const mention = settings.ticket_staff_role_id ? '<@&' + settings.ticket_staff_role_id + '>' : '';

  await channel.send({
    content: mention ? mention + ' new ticket' : undefined,
    embeds: [welcome],
    components: [controls]
  });

  await db.from('audit_log').insert({
    guild_id: interaction.guildId,
    actor_discord_id: interaction.user.id,
    action: 'ticket.open',
    detail: { channel_id: channel.id }
  });

  return reply(interaction, panel('Ticket created', ['Head to ' + channel.toString() + '.']));
}

// ------------------------------------------------------------
// Claim a ticket (staff button)
// ------------------------------------------------------------
async function claimTicket(interaction, db) {
  const settings = await getSettings(db, interaction.guildId);

  if (!(await isTicketStaff(interaction, settings))) {
    return interaction.reply({ content: 'Only staff can claim tickets.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();

  const { data: row } = await db
    .from('tickets')
    .select('claimed_by, status')
    .eq('guild_id', interaction.guildId)
    .eq('channel_id', interaction.channel.id)
    .maybeSingle();

  if (!row) {
    return interaction.editReply({ embeds: [panel('Not a ticket', ['This channel is not a tracked ticket.'])] });
  }

  if (row.claimed_by) {
    return interaction.editReply({
      embeds: [panel('Already claimed', ['This ticket is handled by <@' + row.claimed_by + '>.'])]
    });
  }

  await db.from('tickets')
    .update({ claimed_by: interaction.user.id })
    .eq('guild_id', interaction.guildId)
    .eq('channel_id', interaction.channel.id);

  await db.from('audit_log').insert({
    guild_id: interaction.guildId,
    actor_discord_id: interaction.user.id,
    action: 'ticket.claim',
    detail: { channel_id: interaction.channel.id }
  });

  return interaction.editReply({
    embeds: [panel('Ticket claimed', ['<@' + interaction.user.id + '> is now handling this ticket.'])]
  });
}

// ------------------------------------------------------------
// Build a .txt transcript from the channel history
// ------------------------------------------------------------
async function buildTranscript(channel) {
  let all = [];
  let before;

  // page backwards through history, up to 2000 messages
  for (let i = 0; i < 20; i++) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;

    all = all.concat(Array.from(batch.values()));
    before = batch.last().id;
    if (batch.size < 100) break;
  }

  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const lines = all.map((m) => {
    const when = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    const author = m.author ? m.author.tag : 'unknown';
    let text = m.content || '';

    if (m.embeds && m.embeds.length) {
      const e = m.embeds[0];
      text += ' [embed: ' + (e.title || '') + (e.description ? ' - ' + e.description : '') + ']';
    }
    if (m.attachments && m.attachments.size) {
      text += ' [files: ' + Array.from(m.attachments.values()).map((a) => a.url).join(', ') + ']';
    }

    return '[' + when + '] ' + author + ': ' + text;
  });

  const header = 'Transcript for #' + channel.name + '\n' +
    'Channel ID: ' + channel.id + '\n' +
    'Generated: ' + new Date().toISOString() + '\n' +
    'Messages: ' + all.length + '\n' +
    '='.repeat(50) + '\n\n';

  return header + lines.join('\n') + '\n';
}

// ------------------------------------------------------------
// Close (archive) or Delete a ticket
// mode: 'archive' | 'delete'
// ------------------------------------------------------------
async function endTicket(interaction, db, mode) {
  const settings = await getSettings(db, interaction.guildId);

  if (!(await isTicketStaff(interaction, settings))) {
    return interaction.reply({ content: 'Only staff can close tickets.', flags: MessageFlags.Ephemeral });
  }

  const { data: row } = await db
    .from('tickets')
    .select('opener_id, status')
    .eq('guild_id', interaction.guildId)
    .eq('channel_id', interaction.channel.id)
    .maybeSingle();

  if (!row) {
    return interaction.reply({ content: 'This channel is not a tracked ticket.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();
  await interaction.editReply({
    embeds: [panel(mode === 'delete' ? 'Deleting ticket' : 'Closing ticket', ['Saving transcript first...'])]
  });

  // transcript
  let transcript = '';
  try {
    transcript = await buildTranscript(interaction.channel);
  } catch (e) {
    transcript = 'Transcript could not be generated: ' + e.message + '\n';
  }

  // post transcript to the log channel
  if (settings.ticket_log_channel_id) {
    const logChannel = interaction.guild.channels.cache.get(settings.ticket_log_channel_id);

    if (logChannel && typeof logChannel.send === 'function') {
      const file = new AttachmentBuilder(Buffer.from(transcript, 'utf8'), {
        name: interaction.channel.name + '-transcript.txt'
      });

      await logChannel.send({
        embeds: [panel(mode === 'delete' ? 'Ticket deleted' : 'Ticket closed', [
          'Channel: #' + interaction.channel.name,
          'Opened by: <@' + row.opener_id + '>',
          'Closed by: <@' + interaction.user.id + '>'
        ])],
        files: [file]
      }).catch(() => {});
    }
  }

  await db.from('tickets')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('guild_id', interaction.guildId)
    .eq('channel_id', interaction.channel.id);

  await db.from('audit_log').insert({
    guild_id: interaction.guildId,
    actor_discord_id: interaction.user.id,
    action: mode === 'delete' ? 'ticket.delete' : 'ticket.close',
    detail: { channel_id: interaction.channel.id, opener_id: row.opener_id }
  });

  // ---- delete path ----
  if (mode === 'delete') {
    setTimeout(() => {
      interaction.channel.delete('Ticket deleted by ' + interaction.user.tag).catch(() => {});
    }, 3000);
    return;
  }

  // ---- archive path ----
  const channel = interaction.channel;

  // remove the opener's access, keep staff + log readable
  await channel.permissionOverwrites
    .edit(row.opener_id, { ViewChannel: false })
    .catch(() => {});

  // move to the archive category if one is set, otherwise leave it in place
  if (settings.ticket_archive_id) {
    await channel.setParent(settings.ticket_archive_id, { lockPermissions: false }).catch(() => {});
  }

  await channel.setName('closed-' + channel.name.replace(/^ticket-/, '')).catch(() => {});

  // give staff a Delete button so an archived ticket can still be purged
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(TID.delete).setLabel('Delete permanently').setStyle(ButtonStyle.Danger)
  );

  return channel.send({
    embeds: [panel('Ticket archived', [
      'Closed by <@' + interaction.user.id + '>.',
      'The transcript was saved. Staff can still delete this channel below.'
    ])],
    components: [controls]
  }).catch(() => {});
}

// ------------------------------------------------------------
// /ticketsetup  -  one tap. Creates everything and posts the panel.
// ------------------------------------------------------------
async function handleTicketSetup(interaction, db) {
  const role = interaction.options.getRole('staff_role'); // optional
  const g = interaction.guild;

  async function ensureCategory(name) {
    const existing = g.channels.cache.find(function (c) {
      return c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name.toLowerCase();
    });
    if (existing) return existing;
    return g.channels.create({ name: name, type: ChannelType.GuildCategory });
  }

  let openCat, archiveCat, logChannel;

  try {
    openCat = await ensureCategory('Tickets');
    archiveCat = await ensureCategory('Ticket Archive');

    logChannel = g.channels.cache.find(function (c) {
      return c.type === ChannelType.GuildText && c.name.toLowerCase() === 'ticket-logs';
    });

    if (!logChannel) {
      const overwrites = [
        { id: g.id, deny: [PermissionsBitField.Flags.ViewChannel] }
      ];
      if (role) {
        overwrites.push({ id: role.id, allow: [PermissionsBitField.Flags.ViewChannel] });
      }
      logChannel = await g.channels.create({
        name: 'ticket-logs',
        type: ChannelType.GuildText,
        parent: archiveCat.id,
        permissionOverwrites: overwrites
      });
    }
  } catch (e) {
    return reply(interaction, panel('Setup could not finish', [
      'I need the Manage Channels permission to create the categories and log channel.',
      'Give me that permission, then run /ticketsetup again.'
    ]));
  }

  const patch = {
    guild_id: interaction.guildId,
    ticket_category_id: openCat.id,
    ticket_archive_id: archiveCat.id,
    ticket_log_channel_id: logChannel.id
  };
  if (role) patch.ticket_staff_role_id = role.id;

  await db.from('guild_settings').upsert(patch, { onConflict: 'guild_id' });

  const board = new EmbedBuilder()
    .setTitle('Need help?')
    .setDescription('Press the button below to open a private ticket. Only you and the staff team can see it.')
    .setColor(0xffffff)
    .setFooter({ text: 'One ticket per person at a time' });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(TID.open).setLabel('Open a ticket').setStyle(ButtonStyle.Secondary)
  );

  let posted = true;
  try {
    await interaction.channel.send({ embeds: [board], components: [buttons] });
  } catch (e) {
    posted = false;
  }

  await db.from('audit_log').insert({
    guild_id: interaction.guildId,
    actor_discord_id: interaction.user.id,
    action: 'ticket.setup',
    detail: { open: openCat.id, archive: archiveCat.id, log: logChannel.id, role: role ? role.id : null }
  });

  return reply(interaction, panel('Tickets are ready', [
    'Created the Tickets and Ticket Archive categories and a ticket-logs channel.',
    role ? 'Staff role set to ' + role.name + '.' : 'Anyone with Manage Server can handle tickets.',
    '',
    posted
      ? 'Posted the Open a ticket button in this channel. Pin it so members can find it.'
      : 'Could not post the panel here. Run /ticketpanel in a channel I can post in.',
    '',
    'Change any of this later from the dashboard or with /ticketconfig.'
  ]));
}

// ------------------------------------------------------------
// button router, called from commands.js handleButton
// returns true if it handled the interaction
// ------------------------------------------------------------
async function handleTicketButton(interaction, db) {
  const id = interaction.customId;

  if (id === TID.open) { await openTicket(interaction, db); return true; }
  if (id === TID.claim) { await claimTicket(interaction, db); return true; }
  if (id === TID.close) { await endTicket(interaction, db, 'archive'); return true; }
  if (id === TID.delete) { await endTicket(interaction, db, 'delete'); return true; }

  return false;
}

module.exports = {
  TID,
  handleTicketPanel,
  handleTicketConfig,
  handleTicketSetup,
  handleTicketButton
};
