// ============================================================
// bot/commands.js
// Slash commands, a claim panel with buttons, and the modal
// that lets buyers redeem without typing anything.
//
// UPDATED: wired in the ticket system (bot/tickets.js).
//   - added /ticketpanel and /ticketconfig commands
//   - ticket buttons routed through handleButton
//   - ticket commands added to the router + staff gate
// Nothing from the original premium/key logic was changed.
// ============================================================
'use strict';

const crypto = require('crypto');

const {
  EmbedBuilder,
  PermissionsBitField,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

// NEW: ticket system
const {
  handleTicketPanel,
  handleTicketConfig,
  handleTicketSetup,
  handleTicketButton
} = require('./tickets');

// No O, 0, I or 1 so codes cannot be misread.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const ID = {
  redeem: 'helium:redeem',
  status: 'helium:status',
  modal: 'helium:redeem_modal',
  field: 'code',
  getkey: 'helium:getkey'
};

// Option types: 1 subcommand, 3 string, 4 integer, 6 user, 7 channel, 8 role
const COMMANDS = [
  {
    name: 'redeem',
    description: 'Redeem a premium code',
    options: [
      { name: 'code', description: 'The code you were given', type: 3, required: true }
    ]
  },
  {
    name: 'panel',
    description: 'Post a claim panel with buttons (staff only)',
    options: [
      { name: 'channel', description: 'Where to post it, defaults to here', type: 7, required: false },
      { name: 'title', description: 'Heading shown on the panel', type: 3, required: false },
      { name: 'message', description: 'Text shown under the heading', type: 3, required: false }
    ]
  },
  {
    name: 'keypanel',
    description: 'Post a dashboard key panel (staff only)',
    options: [
      { name: 'channel', description: 'Where to post it, defaults to here', type: 7, required: false },
      { name: 'role', description: 'Only members with this role can claim', type: 8, required: false },
      { name: 'title', description: 'Heading shown on the panel', type: 3, required: false },
      { name: 'message', description: 'Text shown under the heading', type: 3, required: false }
    ]
  },
  {
    name: 'premium',
    description: 'Premium membership',
    options: [
      {
        name: 'status',
        description: 'Check your own premium status',
        type: 1
      },
      {
        name: 'grant',
        description: 'Give premium to a member (staff only)',
        type: 1,
        options: [
          { name: 'user', description: 'Member', type: 6, required: true },
          { name: 'days', description: 'Duration in days', type: 4, required: true, min_value: 1, max_value: 3650 },
          { name: 'tier', description: 'Which product, defaults to basic', type: 3, required: false }
        ]
      },
      {
        name: 'revoke',
        description: 'Remove premium from a member (staff only)',
        type: 1,
        options: [
          { name: 'user', description: 'Member', type: 6, required: true },
          { name: 'tier', description: 'One product only. Leave empty to remove all.', type: 3, required: false }
        ]
      },
      {
        name: 'code',
        description: 'Create a redeemable code (staff only)',
        type: 1,
        options: [
          { name: 'days', description: 'Duration the code grants', type: 4, required: true, min_value: 1, max_value: 3650 },
          { name: 'uses', description: 'How many people can redeem it, default 1', type: 4, required: false, min_value: 1, max_value: 500 },
          { name: 'tier', description: 'Which product, defaults to basic', type: 3, required: false },
          { name: 'note', description: 'Private note for your own records', type: 3, required: false }
        ]
      },
      {
        name: 'codes',
        description: 'List codes that can still be used (staff only)',
        type: 1
      }
    ]
  },

  // ---------------------------------------------------------
  // NEW: ticket commands
  // ---------------------------------------------------------
  {
    name: 'ticketpanel',
    description: 'Post a ticket panel with a reason menu (staff only)',
    options: [
      { name: 'channel', description: 'Where to post it, defaults to here', type: 7, required: false },
      { name: 'title', description: 'Heading shown on the panel', type: 3, required: false },
      { name: 'message', description: 'Text shown under the heading', type: 3, required: false }
    ]
  },
  {
    name: 'ticketconfig',
    description: 'Set up the ticket system (staff only). Run with no options to view current settings.',
    options: [
      { name: 'category', description: 'Category where open tickets are created', type: 7, required: false },
      { name: 'archive', description: 'Category where closed tickets are moved', type: 7, required: false },
      { name: 'staff_role', description: 'Role that can see, claim and close tickets', type: 8, required: false },
      { name: 'log_channel', description: 'Channel where transcripts are posted', type: 7, required: false }
    ]
  },
  {
    name: 'ticketsetup',
    description: 'One tap ticket setup: creates everything and posts the ticket menu (staff only)',
    options: [
      { name: 'staff_role', description: 'Role that can handle tickets. Optional.', type: 8, required: false }
    ]
  }
];

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------

function makeAccessKey() {
  const bytes = crypto.randomBytes(16);
  let out = 'KEY-';

  for (let i = 0; i < 16; i++) {
    if (i === 8) out += '-';
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }

  return out;
}

function makeCode() {
  const bytes = crypto.randomBytes(12);
  let out = '';

  for (let i = 0; i < 12; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
    if (i === 3 || i === 7) out += '-';
  }

  return out;
}

function isStaff(interaction) {
  if (!interaction.memberPermissions) return false;
  return interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild);
}

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

function fmt(iso) {
  if (!iso) return 'no expiry';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

// ------------------------------------------------------------
// Roles are applied straight away so a buyer sees the result
// while the interaction is still open.
// ------------------------------------------------------------
async function applyRole(db, guild, discordId, tier) {
  const { data: map } = await db
    .from('premium_roles')
    .select('role_id')
    .eq('guild_id', guild.id)
    .eq('tier', tier)
    .maybeSingle();

  if (!map) return { ok: false, why: 'No role is mapped to the ' + tier + ' tier yet.' };

  const role = guild.roles.cache.get(map.role_id);
  if (!role) return { ok: false, why: 'The mapped role no longer exists in this server.' };

  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return { ok: false, why: 'That member is not in this server.' };

  try {
    await member.roles.add(role);
  } catch (e) {
    return { ok: false, why: 'I cannot assign that role. Move my role above it in Server Settings.' };
  }

  await db
    .from('premium_members')
    .update({ role_applied: true })
    .eq('guild_id', guild.id)
    .eq('discord_id', discordId)
    .eq('tier', tier);

  return { ok: true, roleName: role.name };
}

// Time left on the same tier is added to, never replaced.
function newExpiry(currentIso, addDays) {
  const now = Date.now();
  const base = currentIso && new Date(currentIso).getTime() > now
    ? new Date(currentIso).getTime()
    : now;

  return new Date(base + addDays * 86400000).toISOString();
}

async function upsertMember(db, guildId, discordId, tier, days, source) {
  const { data: existing } = await db
    .from('premium_members')
    .select('expires_at')
    .eq('guild_id', guildId)
    .eq('discord_id', discordId)
    .eq('tier', tier)
    .maybeSingle();

  const expires = newExpiry(existing && existing.expires_at, days);

  await db.from('premium_members').upsert(
    {
      guild_id: guildId,
      discord_id: discordId,
      tier: tier,
      source: source,
      expires_at: expires,
      role_applied: false
    },
    { onConflict: 'guild_id,discord_id,tier' }
  );

  const extended = Boolean(
    existing && existing.expires_at && new Date(existing.expires_at) > new Date()
  );

  return { expires, extended };
}

// ------------------------------------------------------------
// redeem core, shared by the command and the panel button
// ------------------------------------------------------------
async function redeemCode(interaction, db, rawCode, source) {
  const code = (rawCode || '').trim().toUpperCase();

  const { data: row } = await db
    .from('premium_codes')
    .select('*')
    .eq('code', code)
    .eq('guild_id', interaction.guildId)
    .maybeSingle();

  if (!row) {
    return reply(interaction, panel('Code not found', [
      'Check the spelling and try again.',
      'Codes only work in the server they were made for.'
    ]));
  }

  if (row.disabled) {
    return reply(interaction, panel('Code disabled', ['This code was turned off by staff.']));
  }

  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return reply(interaction, panel('Code expired', ['This code is past its expiry date.']));
  }

  if (row.uses >= row.max_uses) {
    return reply(interaction, panel('Code used up', ['This code has reached its usage limit.']));
  }

  const { error: dupe } = await db
    .from('premium_code_redemptions')
    .insert({ code: code, guild_id: interaction.guildId, discord_id: interaction.user.id });

  if (dupe) {
    return reply(interaction, panel('Already redeemed', ['You have already used this code.']));
  }

  await db.from('premium_codes').update({ uses: row.uses + 1 }).eq('code', code);

  const result = await upsertMember(db, interaction.guildId, interaction.user.id, row.tier, row.days, source || 'code');
  const applied = await applyRole(db, interaction.guild, interaction.user.id, row.tier);

  await db.from('audit_log').insert({
    guild_id: interaction.guildId,
    actor_discord_id: interaction.user.id,
    action: 'premium.redeem',
    detail: { code: code, tier: row.tier, days: row.days, source: source || 'code' }
  });

  return reply(interaction, panel(applied.ok ? 'Access granted' : 'Code accepted', [
    result.extended
      ? 'Added ' + row.days + ' days to your ' + row.tier + ' access.'
      : 'You now have ' + row.days + ' days of ' + row.tier + '.',
    'Valid until ' + fmt(result.expires) + '.',
    '',
    applied.ok
      ? 'Role granted: ' + applied.roleName
      : applied.why + ' Your membership is saved, staff can fix the role.'
  ]));
}

// ------------------------------------------------------------
// status core
// ------------------------------------------------------------
async function showStatus(interaction, db) {
  const { data: rows } = await db
    .from('premium_members')
    .select('tier, expires_at')
    .eq('guild_id', interaction.guildId)
    .eq('discord_id', interaction.user.id)
    .order('tier', { ascending: true });

  if (!rows || rows.length === 0) {
    return reply(interaction, panel('No access yet', [
      'You do not have any premium access in this server.',
      'Redeem a code to activate one.'
    ]));
  }

  const lines = rows.map(function (r) {
    const expired = r.expires_at && new Date(r.expires_at) < new Date();
    const left = r.expires_at
      ? Math.ceil((new Date(r.expires_at).getTime() - Date.now()) / 86400000)
      : null;

    if (expired) return r.tier + ' - expired on ' + fmt(r.expires_at);
    if (left === null) return r.tier + ' - no expiry';
    return r.tier + ' - ' + left + ' day' + (left === 1 ? '' : 's') + ' left, until ' + fmt(r.expires_at);
  });

  return reply(interaction, panel('Your access', lines));
}

// ------------------------------------------------------------
// /panel
// ------------------------------------------------------------
async function handlePanel(interaction, db) {
  const target = interaction.options.getChannel('channel') || interaction.channel;
  const title = interaction.options.getString('title') || 'Claim your access';
  const message = interaction.options.getString('message') ||
    'Bought something? Press Redeem a code and paste the code you were given. Your role is applied straight away.';

  if (!target || typeof target.send !== 'function') {
    return reply(interaction, panel('Cannot post there', ['Pick a normal text channel.']));
  }

  const { data: maps } = await db
    .from('premium_roles')
    .select('tier')
    .eq('guild_id', interaction.guildId);

  const tiers = (maps || []).map(function (m) { return m.tier; });

  const board = new EmbedBuilder()
    .setTitle(title)
    .setDescription(message)
    .setColor(0xffffff);

  if (tiers.length) {
    board.addFields({ name: 'Available', value: tiers.join('\n') });
  }

  board.setFooter({ text: 'Only you can see the replies from these buttons' });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ID.redeem)
      .setLabel('Redeem a code')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(ID.status)
      .setLabel('My access')
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
    action: 'panel.post',
    detail: { channel_id: target.id }
  });

  return reply(interaction, panel('Panel posted', [
    'It stays working forever, even after the bot restarts.',
    'Pin it so buyers can always find it.'
  ]));
}

// ------------------------------------------------------------
// /premium grant
// ------------------------------------------------------------
async function handleGrant(interaction, db) {
  const user = interaction.options.getUser('user');
  const days = interaction.options.getInteger('days');
  const tier = (interaction.options.getString('tier') || 'basic').trim();

  const result = await upsertMember(db, interaction.guildId, user.id, tier, days, 'command');
  const applied = await applyRole(db, interaction.guild, user.id, tier);

  await db.from('audit_log').insert({
    guild_id: interaction.guildId,
    actor_discord_id: interaction.user.id,
    action: 'premium.grant',
    detail: { target: user.id, tier: tier, days: days }
  });

  return reply(interaction, panel('Premium granted', [
    user.username + ' now has ' + tier + '.',
    'Valid until ' + fmt(result.expires) + '.',
    result.extended ? 'Existing time was added to, not replaced.' : '',
    '',
    applied.ok ? 'Role granted: ' + applied.roleName : applied.why
  ]));
}

// ------------------------------------------------------------
// /premium revoke
// ------------------------------------------------------------
async function handleRevoke(interaction, db) {
  const user = interaction.options.getUser('user');
  const only = interaction.options.getString('tier');
  const tier = only ? only.trim() : null;

  let query = db
    .from('premium_members')
    .select('tier, role_applied')
    .eq('guild_id', interaction.guildId)
    .eq('discord_id', user.id);

  if (tier) query = query.eq('tier', tier);

  const { data: rows } = await query;

  if (!rows || rows.length === 0) {
    return reply(interaction, panel('Nothing to revoke', [
      tier
        ? user.username + ' does not have the ' + tier + ' tier.'
        : user.username + ' has no premium access here.'
    ]));
  }

  const { data: maps } = await db
    .from('premium_roles')
    .select('tier, role_id')
    .eq('guild_id', interaction.guildId);

  const roleFor = {};
  (maps || []).forEach(function (m) { roleFor[m.tier] = m.role_id; });

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  const removed = [];
  const failed = [];

  for (const row of rows) {
    const roleId = roleFor[row.tier];
    if (!roleId || !member) continue;

    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) continue;

    try {
      await member.roles.remove(role);
      removed.push(role.name);
    } catch (e) {
      failed.push(role.name);
    }
  }

  let del = db
    .from('premium_members')
    .delete()
    .eq('guild_id', interaction.guildId)
    .eq('discord_id', user.id);

  if (tier) del = del.eq('tier', tier);
  await del;

  await db.from('audit_log').insert({
    guild_id: interaction.guildId,
    actor_discord_id: interaction.user.id,
    action: 'premium.revoke',
    detail: { target: user.id, tier: tier || 'all' }
  });

  return reply(interaction, panel('Premium revoked', [
    tier
      ? user.username + ' lost the ' + tier + ' tier.'
      : user.username + ' lost all premium access.',
    '',
    removed.length ? 'Roles removed: ' + removed.join(', ') : 'No roles needed removing.',
    failed.length ? 'Could not remove: ' + failed.join(', ') + '. Check my role position.' : ''
  ]));
}

// ------------------------------------------------------------
// /premium code
// ------------------------------------------------------------
async function handleCode(interaction, db) {
  const days = interaction.options.getInteger('days');
  const uses = interaction.options.getInteger('uses') || 1;
  const tier = (interaction.options.getString('tier') || 'basic').trim();
  const note = interaction.options.getString('note') || null;

  const code = makeCode();

  const { error } = await db.from('premium_codes').insert({
    code: code,
    guild_id: interaction.guildId,
    tier: tier,
    days: days,
    max_uses: uses,
    note: note,
    created_by: interaction.user.id
  });

  if (error) {
    return reply(interaction, panel('Could not create the code', ['Try running the command again.']));
  }

  return reply(interaction, panel('Code created', [
    '`' + code + '`',
    '',
    'Grants ' + days + ' days of ' + tier + '.',
    uses === 1 ? 'Single use.' : 'Can be used by ' + uses + ' different people.',
    '',
    'Send this to the buyer. They paste it into the panel and the role lands instantly.'
  ]));
}

// ------------------------------------------------------------
// /premium codes
// ------------------------------------------------------------
async function handleCodes(interaction, db) {
  const { data: rows } = await db
    .from('premium_codes')
    .select('code, tier, days, uses, max_uses, note')
    .eq('guild_id', interaction.guildId)
    .eq('disabled', false)
    .order('created_at', { ascending: false })
    .limit(20);

  const usable = (rows || []).filter((r) => r.uses < r.max_uses);

  if (usable.length === 0) {
    return reply(interaction, panel('No usable codes', [
      'Every code has been used up. Make one with /premium code.'
    ]));
  }

  const lines = usable.map((r) => {
    return '`' + r.code + '`  ' + r.days + 'd ' + r.tier +
      '  (' + r.uses + '/' + r.max_uses + ')' + (r.note ? '  ' + r.note : '');
  });

  return reply(interaction, panel('Usable codes', lines));
}

// ------------------------------------------------------------
// /keypanel  -  self service dashboard keys
// ------------------------------------------------------------
async function handleKeyPanel(interaction, db) {
  const target = interaction.options.getChannel('channel') || interaction.channel;
  const role = interaction.options.getRole('role');
  const title = interaction.options.getString('title') || 'Dashboard access';
  const message = interaction.options.getString('message') ||
    'Press the button below to get your own dashboard key. Paste it on the sign in page, then continue with Discord.';

  if (!target || typeof target.send !== 'function') {
    return reply(interaction, panel('Cannot post there', ['Pick a normal text channel.']));
  }

  const board = new EmbedBuilder()
    .setTitle(title)
    .setDescription(message)
    .setColor(0xffffff)
    .setFooter({ text: 'Your key is shown only to you' });

  if (role) board.addFields({ name: 'Requires', value: role.name });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(role ? ID.getkey + ':' + role.id : ID.getkey)
      .setLabel('Get my dashboard key')
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
    action: 'keypanel.post',
    detail: { channel_id: target.id, role_id: role ? role.id : null }
  });

  return reply(interaction, panel('Panel posted', [
    'Each member can claim one key. Pressing again returns the same key.',
    role
      ? 'Only members with ' + role.name + ' can claim.'
      : 'Anyone who can see that channel can claim.'
  ]));
}

async function handleGetKey(interaction, db) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const requiredRole = interaction.customId.split(':')[2] || null;

  if (requiredRole) {
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

    if (!member || !member.roles.cache.has(requiredRole)) {
      return reply(interaction, panel('Not eligible yet', [
        'You need the required role before you can claim a dashboard key.',
        'Redeem your purchase first, then press the button again.'
      ]));
    }
  }

  const { data: existing } = await db
    .from('access_keys')
    .select('key, disabled')
    .eq('guild_id', interaction.guildId)
    .eq('claimed_by', interaction.user.id)
    .maybeSingle();

  if (existing) {
    if (existing.disabled) {
      return reply(interaction, panel('Key disabled', [
        'Your key was turned off by staff. Open a ticket if this is a mistake.'
      ]));
    }

    return reply(interaction, panel('Your dashboard key', [
      '`' + existing.key + '`',
      '',
      'This is the same key you claimed before.',
      'Paste it on the dashboard sign in page.'
    ]));
  }

  const key = makeAccessKey();

  const { error } = await db.from('access_keys').insert({
    key: key,
    label: interaction.user.username,
    guild_id: interaction.guildId,
    claimed_by: interaction.user.id,
    claimed_at: new Date().toISOString(),
    created_by: 'panel'
  });

  if (error) {
    return reply(interaction, panel('Could not create your key', ['Try again in a moment.']));
  }

  await db.from('audit_log').insert({
    guild_id: interaction.guildId,
    actor_discord_id: interaction.user.id,
    action: 'accesskey.claim',
    detail: {}
  });

  return reply(interaction, panel('Your dashboard key', [
    '`' + key + '`',
    '',
    'Paste this on the dashboard sign in page, then continue with Discord.',
    'Keep it private. It is tied to your account.'
  ]));
}

// ------------------------------------------------------------
// panel buttons
// ------------------------------------------------------------
async function handleButton(interaction, db) {
  // NEW: ticket buttons first. Returns true if it handled it.
  if (interaction.customId.startsWith('ticket:')) {
    const handled = await handleTicketButton(interaction, db);
    if (handled) return;
  }

  if (interaction.customId === ID.redeem) {
    const field = new TextInputBuilder()
      .setCustomId(ID.field)
      .setLabel('Your code')
      .setPlaceholder('XXXX-XXXX-XXXX')
      .setStyle(TextInputStyle.Short)
      .setMinLength(6)
      .setMaxLength(32)
      .setRequired(true);

    const form = new ModalBuilder()
      .setCustomId(ID.modal)
      .setTitle('Redeem a code')
      .addComponents(new ActionRowBuilder().addComponents(field));

    // A modal has to be the first response, so no defer here.
    return interaction.showModal(form);
  }

  if (interaction.customId === ID.status) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return showStatus(interaction, db);
  }

  if (interaction.customId.split(':').slice(0, 2).join(':') === ID.getkey) {
    return handleGetKey(interaction, db);
  }
}

async function handleModal(interaction, db) {
  if (interaction.customId !== ID.modal) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const code = interaction.fields.getTextInputValue(ID.field);

  return redeemCode(interaction, db, code, 'panel');
}

// ------------------------------------------------------------
// router
// ------------------------------------------------------------
async function handleInteraction(interaction, db) {
  if (!interaction.guildId) {
    if (interaction.isRepliable()) {
      return interaction.reply({
        content: 'This only works inside a server.',
        flags: MessageFlags.Ephemeral
      });
    }
    return;
  }

  try {
    if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('ticket:')) {
        return await handleTicketButton(interaction, db);
      }
      return;
    }
    if (interaction.isRoleSelectMenu && interaction.isRoleSelectMenu()) {
      if (interaction.customId.startsWith('ticket:')) {
        return await handleTicketButton(interaction, db);
      }
      return;
    }
    if (interaction.isButton()) return await handleButton(interaction, db);
    if (interaction.isModalSubmit()) return await handleModal(interaction, db);
    if (!interaction.isChatInputCommand()) return;

    const name = interaction.commandName;
    const sub = name === 'premium' ? interaction.options.getSubcommand() : null;
    const staffOnly = ['grant', 'revoke', 'code', 'codes'];
    const needsStaff =
      name === 'panel' ||
      name === 'keypanel' ||
      name === 'ticketpanel' ||
      name === 'ticketconfig' ||
      name === 'ticketsetup' ||   // NEW
      (sub && staffOnly.includes(sub));

    if (needsStaff && !isStaff(interaction)) {
      return interaction.reply({
        content: 'You need the Manage Server permission to use this.',
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (name === 'redeem') {
      return await redeemCode(interaction, db, interaction.options.getString('code'), 'command');
    }
    if (name === 'panel') return await handlePanel(interaction, db);
    if (name === 'keypanel') return await handleKeyPanel(interaction, db);
    if (name === 'ticketpanel') return await handleTicketPanel(interaction, db);
    if (name === 'ticketconfig') return await handleTicketConfig(interaction, db);
    if (name === 'ticketsetup') return await handleTicketSetup(interaction, db);   // NEW
    if (sub === 'status') return await showStatus(interaction, db);
    if (sub === 'grant') return await handleGrant(interaction, db);
    if (sub === 'revoke') return await handleRevoke(interaction, db);
    if (sub === 'code') return await handleCode(interaction, db);
    if (sub === 'codes') return await handleCodes(interaction, db);
  } catch (e) {
    console.error('Interaction failed: ' + e.message);

    const embed = panel('Something went wrong', ['Try again in a moment.']);

    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ embeds: [embed] }).catch(() => {});
    }
    if (interaction.isRepliable()) {
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

// ------------------------------------------------------------
// registration, per guild so commands appear immediately
// ------------------------------------------------------------
async function registerCommands(guild) {
  try {
    await guild.commands.set(COMMANDS);
    console.log('Commands registered in ' + guild.name);
  } catch (e) {
    console.error('Command registration failed for ' + guild.id + ': ' + e.message);
  }
}

module.exports = { COMMANDS, handleInteraction, registerCommands };
