/* Savdo Marketplace — reminder engine (runs in GitHub Actions every 10 min).
   /start and favorites-sync are now handled INSTANTLY by the savdoBotWebhook
   Telegram webhook (not this cron) — getUpdates polling was removed here
   because Telegram rejects getUpdates with 409 Conflict once a webhook is set.
   This script now only does the periodic sweep: send reminders for favorited
   listings that are still available (max 3/day, quiet hours 08:00-22:00
   local UTC+5), silently stop when sold/deleted, and re-engage users who
   haven't opened the app in 48h (max once per 48h).
   State lives in the repo: data/subs.json (favorites are written there by the
   webhook function; this script only reads+updates reminder bookkeeping). */

import fs from 'node:fs';
import { execSync } from 'node:child_process';

const API = process.env.TG_API_BASE || 'https://api.telegram.org';
const TOKEN = process.env.SAVDO_BOT_TOKEN;
const DRY = process.env.DRY_RUN === 'true';
const SITE = 'https://dostonravshanov1006800-beep.github.io/savdo-usernames-market/?v=11';
const TZ_MS = 5 * 3600e3;                 // Asia/Samarkand UTC+5
const MAX_REM = 3;                          // max favorite-reminders per day
const REM_GAP = 4 * 3600e3;                 // min gap between reminders
const REENGAGE_AFTER = 48 * 3600e3;         // no visit for 2 days -> ping
const REENGAGE_GAP = 48 * 3600e3;           // max 1 re-engage per 48h
const QUIET_START = 8;                     // local hours allowed to write
const QUIET_END = 22;

if (!TOKEN && !DRY) { console.log('no token'); process.exit(1); }
const now = Date.now();
const local = ts => new Date(ts + TZ_MS);
const dayKey = ts => local(ts).toISOString().slice(0, 10);
const localHour = ts => local(ts).getUTCHours();

const read = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return structuredClone(d); } };
const subs = read('data/subs.json', { subs: [] });
const listings = read('data/listings.json', { listings: [] });
const byId = Object.fromEntries(listings.listings.map(l => [l.id, l]));

const tg = (m, body) => fetch(`${API}/bot${TOKEN}/${m}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}).then(r => r.json());

const fmtPrice = l => l.currency === 'USD' ? `$${(l.price / 100).toLocaleString('en-US')}` : `${l.price.toLocaleString('ru-RU')} сум`;

async function send(id, text) {
  if (DRY) { console.log(`DRY send -> ${id}: ${text.split('\n')[0]}`); return true; }
  let res = await tg('sendMessage', {
    chat_id: id, text, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '🛍 Открыть каталог', web_app: { url: SITE } }]] }
  });
  if (!res.ok && (res.description || '').includes('Too Many Requests')) {
    await new Promise(r => setTimeout(r, ((res.parameters || {}).retry_after || 3) * 1000));
    res = await tg('sendMessage', {
      chat_id: id, text, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🛍 Открыть каталог', web_app: { url: SITE } }]] }
    });
  }
  if (!res.ok) console.log(`send fail ${id}: ${res.description}`);
  return res.ok;
}

if (!DRY) {
  await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: '🛍 Savdo', web_app: { url: SITE } } });
}

/* ---- notification engine ---- */
const dk = dayKey(now);
const awake = localHour(now) >= QUIET_START && localHour(now) < QUIET_END;
for (const s of subs.subs) {
  if (s.day !== dk) { s.day = dk; s.rem = 0; s.sent = 0; }
  // prune sold/deleted favorites silently
  const before = s.favs.length;
  s.favs = s.favs.filter(id => { const l = byId[id]; return l && l.status !== 'sold'; });
  if (s.favs.length !== before) console.log(`pruned user=${s.id} ${before}->${s.favs.length}`);
  if (!awake) continue;
  const act = s.favs.map(id => byId[id]).filter(l => l && l.status !== 'sold');
  if (act.length && s.rem < MAX_REM && now - (s.last_rem || 0) >= REM_GAP) {
    const lines = act.slice(0, 10).map((l, i) =>
      `${i + 1}. <b>${l.username || l.displayName || l.id}</b> — ${fmtPrice(l)}${l.status === 'reserved' ? ' (зарезервирован)' : ''}`);
    const ok = await send(s.id, `🔔 <b>Напоминание — лоты из избранного ещё доступны:</b>\n\n${lines.join('\n')}\n\nЕсли возьмёшь — лот исчезнет из отслеживания сам.`);
    if (ok) { s.rem++; s.sent++; s.last_rem = now; console.log(`reminder user=${s.id} n=${act.length}`); }
  } else if (s.favs.length && now - (s.last_seen || 0) >= REENGAGE_AFTER && now - (s.last_re || 0) >= REENGAGE_GAP) {
    const ok = await send(s.id, `👋 Ты давно не заходил в <b>Savdo Marketplace</b>.\n\nКаталог обновляется — проверь актуальные лоты и цены. Твоё избранное всё ещё отслеживается.`);
    if (ok) { s.sent++; s.last_re = now; console.log(`re-engage user=${s.id}`); }
  }
}

/* ---- persist ---- */
if (!DRY) {
  fs.writeFileSync('data/subs.json', JSON.stringify(subs, null, 2) + '\n');
  try {
    if (execSync('git status --porcelain data/subs.json').toString().trim()) {
      execSync('git config user.name "savdo-notifier"');
      execSync('git config user.email "savdo-notifier@users.noreply.github.com"');
      execSync('git add data/subs.json');
      execSync('git commit -m "chore: reminder sweep"');
      execSync('git pull --rebase -X theirs');
      execSync('git push');
      console.log('state committed');
    } else console.log('no state changes');
  } catch (e) { console.log('commit failed:', String(e).slice(0, 200)); }
} else console.log('DRY: state not saved');
console.log('cycle done, subs:', subs.subs.length);
