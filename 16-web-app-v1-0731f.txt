// ============================================================
// web/app.js
// Shared auth + API helper para sa lahat ng page
// ============================================================
'use strict';

var DISCORD_TOKEN_KEY = 'dash_discord_token';

var sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

// ------------------------------------------------------------
// Ang provider_token ay ang Discord access token ng user.
// Kailangan ito ng API para makita kung anong server ang
// kaya niyang i manage. Isinasave natin agad pagka login
// dahil minsan hindi na ito ibinabalik sa susunod na load.
// ------------------------------------------------------------
sb.auth.onAuthStateChange(function (event, session) {
  if (session && session.provider_token) {
    localStorage.setItem(DISCORD_TOKEN_KEY, session.provider_token);
  }
  if (event === 'SIGNED_OUT') {
    localStorage.removeItem(DISCORD_TOKEN_KEY);
  }
});

// ------------------------------------------------------------
// auth
// ------------------------------------------------------------
async function signIn() {
  var res = await sb.auth.signInWithOAuth({
    provider: 'discord',
    options: {
      // Ang guilds scope ang nagpapahintulot sa atin na
      // makita ang listahan ng server ng user.
      scopes: 'identify email guilds',
      redirectTo: window.location.origin + '/dashboard.html'
    }
  });
  if (res.error) toast(res.error.message, 'err');
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
// api caller
// ------------------------------------------------------------
async function api(path, options) {
  var opts = options || {};
  var session = await getSession();

  if (!session) {
    window.location.replace('index.html');
    throw new Error('Walang session');
  }

  var discordToken = localStorage.getItem(DISCORD_TOKEN_KEY) || '';

  var headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + session.access_token,
    'x-discord-token': discordToken
  };

  var res;
  try {
    res = await fetch(CONFIG.API_BASE_URL + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
  } catch (e) {
    throw new Error('Hindi maabot ang server. Baka natutulog pa, hintayin mo ng isang minuto.');
  }

  var payload = null;
  try {
    payload = await res.json();
  } catch (e) {
    payload = null;
  }

  if (!res.ok) {
    var msg = (payload && payload.error) || 'Error ' + res.status;

    if (res.status === 401 || msg.indexOf('x-discord-token') !== -1) {
      throw new Error('Expired na ang Discord login mo. Mag logout at login ulit.');
    }
    throw new Error(msg);
  }

  return payload;
}

// ------------------------------------------------------------
// ui helpers
// ------------------------------------------------------------
var toastTimer = null;

function toast(message, kind) {
  var el = document.getElementById('toast');
  if (!el) return;

  el.textContent = message;
  el.className = 'toast show ' + (kind || '');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    el.className = 'toast';
  }, 4000);
}

function esc(text) {
  return String(text === null || text === undefined ? '' : text)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;');
}

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function guildIcon(guild, size) {
  var px = size || 44;
  if (guild.icon) {
    return (
      '<img src="https://cdn.discordapp.com/icons/' +
      guild.id + '/' + guild.icon + '.png?size=64" width="' + px + '" height="' + px + '" alt="">'
    );
  }
  var letter = esc((guild.name || '?').charAt(0).toUpperCase());
  return '<div class="fallback">' + letter + '</div>';
}

function botInviteUrl(guildId) {
  var base = 'https://discord.com/oauth2/authorize';
  var params =
    '?client_id=' + encodeURIComponent(CONFIG.DISCORD_CLIENT_ID) +
    '&scope=bot%20applications.commands' +
    '&permissions=268503040';
  if (guildId) params += '&guild_id=' + encodeURIComponent(guildId);
  return base + params;
}

function fmtDate(iso) {
  if (!iso) return 'walang expiry';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function daysLeft(iso) {
  if (!iso) return null;
  var ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / 86400000);
}

// ------------------------------------------------------------
// fill a select element
// ------------------------------------------------------------
function fillSelect(selectEl, items, selectedId, emptyLabel) {
  var html = '<option value="">' + esc(emptyLabel || 'Wala') + '</option>';

  items.forEach(function (item) {
    var sel = String(item.id) === String(selectedId) ? ' selected' : '';
    html += '<option value="' + esc(item.id) + '"' + sel + '>' + esc(item.name) + '</option>';
  });

  selectEl.innerHTML = html;
}
