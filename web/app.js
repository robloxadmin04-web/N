// ============================================================
// web/app.js
// Shared auth, API client and UI helpers.
// ============================================================
'use strict';

var DISCORD_TOKEN_KEY = 'helium_discord_token';

var sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

// The Discord access token is only handed back on the initial
// sign in, so it is cached here for later API calls.
sb.auth.onAuthStateChange(function (event, session) {
  if (session && session.provider_token) {
    localStorage.setItem(DISCORD_TOKEN_KEY, session.provider_token);
  }
  if (event === 'SIGNED_OUT') {
    localStorage.removeItem(DISCORD_TOKEN_KEY);
  }
});

// ------------------------------------------------------------
// Icons
// ------------------------------------------------------------

var ICONS = {
  discord:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.445.865-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.6 12.6 0 0 0-.617-1.25.077.077 0 0 0-.079-.036A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>',

  check:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 4.5 6.5 11.5 3 8"/></svg>',

  chevron:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',

  plus:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>',

  users:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 13.5v-1a2.5 2.5 0 0 0-2.5-2.5h-4A2.5 2.5 0 0 0 2 12.5v1"/><circle cx="6.5" cy="5" r="2.5"/><path d="M14 13.5v-1a2.5 2.5 0 0 0-1.9-2.42M10.5 2.65a2.5 2.5 0 0 1 0 4.7"/></svg>',

  dot:
    '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="3"/></svg>',

  trash:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5h11M6 4.5V3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1.5M12.5 4.5 12 13a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 13l-.5-8.5"/></svg>',

  inbox:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9.5h3l1 2h4l1-2h3"/><path d="M2.8 3.2h10.4l1.3 6.3v3.1a.9.9 0 0 1-.9.9H2.4a.9.9 0 0 1-.9-.9V9.5z"/></svg>',

  info:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 7.4v3.6M8 5.2h.01"/></svg>'
};

function icon(name) {
  return ICONS[name] || '';
}

// ------------------------------------------------------------
// Auth
// ------------------------------------------------------------

async function signIn() {
  var res = await sb.auth.signInWithOAuth({
    provider: 'discord',
    options: {
      // The guilds scope is what lets us list the servers
      // this person is allowed to manage.
      scopes: 'identify email guilds',
      redirectTo: window.location.origin + '/dashboard.html'
    }
  });
  if (res.error) notify(res.error.message, 'error');
}

async function signOut() {
  await sb.auth.signOut();
  localStorage.removeItem(DISCORD_TOKEN_KEY);
  window.location.href = 'index.html';
}

async function getSession() {
  var out = await sb.auth.getSession();
  return out.data.session;
}

async function requireAuth() {
  var session = await getSession();
  if (!session) {
    window.location.replace('index.html');
    return null;
  }
  return session;
}

// ------------------------------------------------------------
// API client
// ------------------------------------------------------------

async function api(path, options) {
  var opts = options || {};
  var session = await getSession();

  if (!session) {
    window.location.replace('index.html');
    throw new Error('Session expired');
  }

  var headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + session.access_token,
    'x-discord-token': localStorage.getItem(DISCORD_TOKEN_KEY) || ''
  };

  var res;
  try {
    res = await fetch(CONFIG.API_BASE_URL + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
  } catch (e) {
    throw new Error('Could not reach the server. It may be waking up, try again in a minute.');
  }

  var payload = null;
  try {
    payload = await res.json();
  } catch (e) {
    payload = null;
  }

  if (!res.ok) {
    var msg = (payload && payload.error) || 'Request failed with status ' + res.status;
    if (res.status === 401 || msg.indexOf('x-discord-token') !== -1) {
      throw new Error('Your Discord session expired. Sign out and sign in again.');
    }
    throw new Error(msg);
  }

  return payload;
}

// ------------------------------------------------------------
// UI helpers
// ------------------------------------------------------------

var notifyTimer = null;

function notify(message, kind) {
  var el = document.getElementById('toast');
  if (!el) return;

  el.innerHTML = icon(kind === 'error' ? 'info' : 'check') + '<span></span>';
  el.querySelector('span').textContent = message;
  el.setAttribute('data-kind', kind || 'ok');
  el.setAttribute('data-show', 'true');

  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(function () {
    el.setAttribute('data-show', 'false');
  }, 4200);
}

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;');
}

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function emptyState(title, detail) {
  return (
    '<div class="empty">' + icon('inbox') +
    '<span class="strong">' + esc(title) + '</span>' +
    esc(detail || '') + '</div>'
  );
}

function guildAvatar(guild) {
  if (guild.icon) {
    return (
      '<img class="avatar" alt="" src="https://cdn.discordapp.com/icons/' +
      esc(guild.id) + '/' + esc(guild.icon) + '.png?size=96">'
    );
  }
  var letter = esc((guild.name || '?').trim().charAt(0).toUpperCase());
  return '<div class="avatar-fb">' + letter + '</div>';
}

// ------------------------------------------------------------
// Bot invite
// View Channels, Send Messages, Embed Links,
// Read Message History, Manage Roles
// ------------------------------------------------------------

function botInviteUrl(guildId) {
  var url =
    'https://discord.com/oauth2/authorize' +
    '?client_id=' + encodeURIComponent(CONFIG.DISCORD_CLIENT_ID) +
    '&scope=bot%20applications.commands' +
    '&permissions=268520448';

  if (guildId) url += '&guild_id=' + encodeURIComponent(guildId);
  return url;
}

// ------------------------------------------------------------
// Formatting
// ------------------------------------------------------------

function formatDate(iso) {
  if (!iso) return 'No expiry';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function daysLeft(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

function expiryLabel(iso) {
  var left = daysLeft(iso);
  if (left === null) return 'No expiry';
  if (left <= 0) return 'Expired';
  if (left === 1) return '1 day left';
  return left + ' days left';
}

function fillSelect(el, items, selectedId, placeholder) {
  var html = '<option value="">' + esc(placeholder || 'None') + '</option>';

  items.forEach(function (item) {
    var selected = String(item.id) === String(selectedId) ? ' selected' : '';
    html += '<option value="' + esc(item.id) + '"' + selected + '>' + esc(item.name) + '</option>';
  });

  el.innerHTML = html;
}
