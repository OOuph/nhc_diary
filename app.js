'use strict';
/* Практика v2 — веб-приложение для медитации.
   Базовая практика: ходьба N мин → сидячая N мин → благодарность; N растёт по программе каждый понедельник.
   Пу-то: секундомер. Итог дня: практики задним числом, дыхание 50/50, привычки, рефлексия.
   Два стрика: практика и трезвость. Календарь с отметками.
   Данные — в localStorage телефона. Сервер нужен только для пушей (вибро на заблокированном экране). */

// ===== НАСТРОЙКИ И КОНСТАНТЫ =====
const CONFIG = {
  STORAGE_KEY: 'practice.v1',          // ключ не меняем: данные v1 читаются как есть
  ACTIVE_KEY: 'practice.active.v1',    // чекпоинт идущей сессии
  LOG_KEY: 'practice.log.v1',
  LOG_MAX: 400,
  LOG_LEVEL: 'DEBUG',                  // DEBUG | INFO | WARNING | ERROR
  MIN_SAVE_SEC: 30,                    // сессии короче не сохраняются
  TICK_MS: 250,
  SLIDER_MAX_MIN: 30,
  PUTO_DEFAULT_MIN: 10,
  PUTO_MAX_MIN: 90,
  PUSH_API: '/api/push',
  AUDIO_SAMPLE_RATE: 8000,             // 8 кГц, 8 бит: ~0.5 МБ на минуту
  AUDIO_TAIL_SEC: 12,
  BELL: { f0: 392, strikeSec: 7, partials: [[1, 1, 0.55], [2.76, 0.45, 1.3], [5.4, 0.22, 2.4], [8.9, 0.1, 3.6]] },
  SCALES: {
    mood: { name: 'Настроение', lo: 'плохое', hi: 'отличное' },
    energy: { name: 'Энергия', lo: 'на нуле', hi: 'полон сил' },
  },
  OLD_MORNING_Q: ['Намерение на день — одной фразой', 'Когда сегодня базовая практика и пу-то?'],
  OLD_EVENING_Q: ['Где удавалось держать дыхание 50/50, а где терял?', 'Что заметил во время практики?', 'Что завтра сделать иначе?'],
  HABITS: [
    { id: 'alcohol', name: 'Алкоголь', short: 'А' },
    { id: 'nicotine', name: 'Никотин', short: 'Н' },
    { id: 'weed', name: 'Марихуана', short: 'М' },
  ],
  DEFAULT_SETTINGS: {
    programStart: null,                // понедельник старта программы (YYYY-MM-DD), ставится при первом запуске
    programStartMin: 5,                // минут на часть в первую неделю
    programMaxMin: 15,                 // потолок
    programStepMin: 1,                 // прибавка каждый понедельник
    dayStartHour: 4,                   // день начинается в 04:00
    eveningFromHour: 19,
    keepScreenOn: true,
    theme: 'light',                    // light | dark | auto (как в системе)
    pushEnabled: false,
    phaseNames: ['Ходьба', 'Сидячая', 'Благодарность'],
    gratitudePrompt: 'Произнеси благодарность — вслух или про себя.',
    morningQuestions: [],              // доп. текстовые вопросы — по желанию, в настройках
    eveningQuestions: [],
    tasksCount: 3,                     // важных дел утром
  },
};

// ===== ЛОГИ =====
const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };
let logBuf = [];
try { logBuf = JSON.parse(localStorage.getItem(CONFIG.LOG_KEY) || '[]'); } catch (e) { logBuf = []; }
function log(level, msg, data) {
  if (LEVELS[level] < LEVELS[CONFIG.LOG_LEVEL]) return;
  const line = `${new Date().toISOString()} ${level} ${msg}${data !== undefined ? ' ' + safeJson(data) : ''}`;
  (level === 'ERROR' ? console.error : level === 'WARNING' ? console.warn : console.log)(line);
  logBuf.push(line);
  if (logBuf.length > CONFIG.LOG_MAX) logBuf = logBuf.slice(-CONFIG.LOG_MAX);
  try { localStorage.setItem(CONFIG.LOG_KEY, JSON.stringify(logBuf)); } catch (e) { /* лог не критичен */ }
}
function safeJson(x) { try { return JSON.stringify(x); } catch (e) { return String(x); } }
window.addEventListener('error', e => log('ERROR', 'uncaught', { msg: e.message, src: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', e => log('ERROR', 'unhandled rejection', String(e.reason)));

// ===== ДАТЫ =====
const pad = n => String(n).padStart(2, '0');
const keyOfDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOfKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = dateOfKey(k); d.setDate(d.getDate() + n); return keyOfDate(d); };
const dayKey = (ts = Date.now()) => keyOfDate(new Date(ts - S().dayStartHour * 3600e3));
const mondayOf = k => { const d = dateOfKey(k); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return keyOfDate(d); };
const daysBetween = (a, b) => Math.round((dateOfKey(b) - dateOfKey(a)) / 864e5);
const fmtDay = k => new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(dateOfKey(k));
const fmtShort = k => new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }).format(dateOfKey(k));
const fmtTime = ts => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
const fmtClock = sec => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`; };
const fmtMin = sec => `${Math.round(sec / 60)} мин`;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many; };
const dni = n => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

// ===== ХРАНИЛИЩЕ =====
let state = loadState();
function loadState() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      s.settings = { ...CONFIG.DEFAULT_SETTINGS, ...(s.settings || {}) };
      s.days = s.days || {};
      if ((s.version || 1) < 3) {
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        if (same(s.settings.morningQuestions, CONFIG.OLD_MORNING_Q)) s.settings.morningQuestions = [];
        if (same(s.settings.eveningQuestions, CONFIG.OLD_EVENING_Q)) s.settings.eveningQuestions = [];
        log('INFO', 'migrate state', { from: s.version || 1, to: 3 }); s.version = 3;
      }
      log('INFO', 'state loaded', { days: Object.keys(s.days).length });
      return s;
    }
  } catch (e) { log('ERROR', 'state load failed', e.message); }
  log('INFO', 'fresh state');
  return { version: 3, settings: { ...CONFIG.DEFAULT_SETTINGS }, days: {} };
}
function saveState() {
  try { localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { log('ERROR', 'save failed', e.message); toast('Не удалось сохранить: ' + e.message); }
}
function S() { return state.settings; }
const applyTheme = () => { document.documentElement.dataset.theme = S().theme || 'light'; };
applyTheme();
if (!S().programStart) { S().programStart = mondayOf(dayKey()); saveState(); log('INFO', 'program start set', S().programStart); }
function getDay(k) { return state.days[k] || { sessions: [], morning: null, evening: null }; }
function ensureDay(k) { return (state.days[k] ||= { sessions: [], morning: null, evening: null }); }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(ok => log('INFO', 'storage.persist', ok)).catch(() => {});

// ===== ПРОГРАММА: +1 мин на часть каждый понедельник =====
function programWeek(k = dayKey()) { return Math.max(0, Math.floor(daysBetween(S().programStart, mondayOf(k)) / 7)); }
function programMin(k = dayKey()) { const st = S(); return Math.min(st.programMaxMin, st.programStartMin + programWeek(k) * st.programStepMin); }
const goalSec = k => programMin(k) * 2 * 60;

// ===== СТАТИСТИКА И СТРИКИ =====
const sumSec = (k, kind) => getDay(k).sessions.filter(s => s.kind === kind).reduce((a, s) => a + s.sec, 0);
const hasBase = k => getDay(k).sessions.some(s => s.kind === 'base');
const habitsOf = k => getDay(k).evening?.habits || null;
const habitsDone = k => { const h = habitsOf(k); return !!h && CONFIG.HABITS.every(x => typeof h[x.id] === 'boolean'); };
const isSober = k => habitsDone(k) && CONFIG.HABITS.every(x => habitsOf(k)[x.id] === false);
const usedHabits = k => habitsDone(k) ? CONFIG.HABITS.filter(x => habitsOf(k)[x.id]) : [];
// Стрик: сегодня ещё не отмечено — серия держится со вчера.
function streak(pred, doneToday) {
  let k = dayKey();
  if (!doneToday(k)) k = addDays(k, -1);
  let n = 0;
  while (pred(k)) { n++; k = addDays(k, -1); }
  return n;
}
function bestStreak(pred) {
  const keys = Object.keys(state.days).filter(pred).sort();
  let best = 0, run = 0, prev = null;
  for (const k of keys) { run = prev && addDays(prev, 1) === k ? run + 1 : 1; best = Math.max(best, run); prev = k; }
  return best;
}
const practiceStreak = () => streak(hasBase, hasBase);
const soberStreak = () => streak(isSober, habitsDone);
const daysWithout = id => streak(k => habitsDone(k) && habitsOf(k)[id] === false, habitsDone);

// ===== ИКОНКИ =====
const ICONS = {
  walk: '<circle cx="13" cy="4" r="1.6"/><path d="M7 21l3-4"/><path d="M16 21l-2-4-3-3 1-6"/><path d="M6 12l2-3 4-1 3 3 3 1"/>',
  sit: '<circle cx="12" cy="5" r="1.8"/><path d="M12 7.5v5.5"/><path d="M12 9.5l-3.5 2.5-1.5 3.5"/><path d="M12 9.5l3.5 2.5 1.5 3.5"/><path d="M4 18.5c2.5-1.8 5.2-2.7 8-2.7s5.5.9 8 2.7"/><path d="M4 18.5h16"/>',
  thanks: '<path d="M12 20s-7-4.4-7-9.6A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.4C19 15.6 12 20 12 20z"/><path d="M12 4V2.5"/><path d="M8 4.5l-.8-1.2"/><path d="M16 4.5l.8-1.2"/>',
  puto: '<path d="M8 3.5c1.6 0 2.8 1.7 2.8 4.1S9.6 11.8 8 11.8 5.2 10 5.2 7.6 6.4 3.5 8 3.5z"/><path d="M6.4 14.2h3.2v1.4a1.6 1.6 0 0 1-3.2 0z"/><path d="M16 8.5c1.6 0 2.8 1.7 2.8 4.1s-1.2 4.2-2.8 4.2-2.8-1.8-2.8-4.2 1.2-4.1 2.8-4.1z"/><path d="M14.4 19.2h3.2v.4a1.6 1.6 0 0 1-3.2 0z"/>',
  breath: '<path d="M5 8h8.5a2.5 2.5 0 1 0-2.3-3.2"/><path d="M3 12h15.5a2.5 2.5 0 1 1-2.3 3.2"/><path d="M4 16h5.5a2.5 2.5 0 1 1-2.3 3.2"/>',
  sun: '<circle cx="12" cy="13" r="4"/><path d="M3 20h18"/><path d="M12 3v2"/><path d="M4.9 6l1.4 1.4"/><path d="M19.1 6l-1.4 1.4"/><path d="M2.5 13h2"/><path d="M19.5 13h2"/>',
  moon: '<path d="M12 3a7.5 7.5 0 0 0 8.3 12.4A9 9 0 1 1 12 3z"/>',
  flame: '<path d="M12 12c2-3 0-7-1-8 0 3-1.8 4.7-3 6-1.2 1.3-2 3.2-2 5a6 6 0 1 0 12 0c0-1.5-1-3.9-2-5-1.8 3-2.8 3-4 2z"/>',
  leaf: '<path d="M5 21c.5-4.5 2.5-8 7-10"/><path d="M9 18c6.2 0 10.5-3.3 11-12V4h-4c-9 0-12 4-12 9 0 1 0 3 2 5h3z"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  pause: '<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>',
  next: '<path d="M5 5l9 7-9 7z"/><path d="M18 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  bell: '<path d="M10 5a2 2 0 1 1 4 0 7 7 0 0 1 4 6v3a4 4 0 0 0 2 3H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 4-6"/><path d="M9 17v1a3 3 0 0 0 6 0v-1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  vibe: '<rect x="8" y="4" width="8" height="16" rx="1.5"/><path d="M4 9v6M20 9v6M2 11v2M22 11v2"/>',
};
const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const PHASE_ICON = ['walk', 'sit', 'thanks'];

// ===== ЗВУК =====
// iOS усыпляет JS при заблокированном экране, но не прерывает начатое аудио.
// Поэтому вся оставшаяся часть сессии — один WAV-файл: тишина + удары колокола в нужные моменты.
const audio = new Audio();
audio.preload = 'auto';
let audioUrl = null, audioOn = false;
audio.addEventListener('ended', () => { audioOn = false; log('DEBUG', 'audio ended'); });
audio.addEventListener('pause', () => { audioOn = false; });
audio.addEventListener('playing', () => { audioOn = true; });

function buildWav(durationSec, strikes) {
  const SR = CONFIG.AUDIO_SAMPLE_RATE, n = Math.ceil(durationSec * SR);
  const buf = new Uint8Array(44 + n), dv = new DataView(buf.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, SR, true); dv.setUint32(28, SR, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  str(36, 'data'); dv.setUint32(40, n, true);
  buf.fill(128, 44);
  const { f0, strikeSec, partials } = CONFIG.BELL, len = Math.floor(strikeSec * SR);
  for (const { t, gain } of strikes) {
    const s0 = Math.floor(t * SR);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const x = i / SR, attack = Math.min(1, x / 0.004);
      let v = 0;
      for (const [ratio, amp, decay] of partials) v += amp * Math.exp(-x * decay) * Math.sin(2 * Math.PI * f0 * ratio * x);
      const idx = 44 + s0 + i;
      buf[idx] = Math.max(0, Math.min(255, Math.round(buf[idx] + v * gain * attack * 70)));
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
// Удары: старт — один, переход ходьба→сидячая — два, конец — три.
function strikesFrom(a, pe) {
  const N = a.phaseSec, out = [], one = (t, g) => out.push({ t, gain: g });
  if (pe < 1) one(0.3, 0.8);
  let end = N - pe;
  if (a.phase === 'walk') { one(end, 0.8); one(end + 2.2, 0.8); end += N; }
  [0, 2.5, 5].forEach(d => one(end + d, 0.9));
  return { strikes: out, duration: end + CONFIG.AUDIO_TAIL_SEC };
}
function playFromActive() {
  const a = active;
  if (!a || a.kind !== 'base' || a.pausedAt) return;
  const pe = phaseElapsed(a), { strikes, duration } = strikesFrom(a, pe);
  const t0 = performance.now(), blob = buildWav(duration, strikes);
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(blob);
  audio.src = audioUrl;
  log('DEBUG', 'audio built', { phase: a.phase, pe: Math.round(pe), duration: Math.round(duration), mb: +(blob.size / 1e6).toFixed(1), ms: Math.round(performance.now() - t0) });
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: 'Базовая практика', artist: `${S().phaseNames[0]} и ${S().phaseNames[1].toLowerCase()} по ${Math.round(a.phaseSec / 60)} мин` }); } catch (e) { /* не везде есть */ }
  }
  audio.play().then(() => { audioOn = true; render(); }).catch(err => {
    audioOn = false; log('WARNING', 'audio play failed', err.message);
    toast('Звук не запустился — нажми «Включить звук»'); render();
  });
}
function stopAudio() { try { audio.pause(); } catch (e) { /* ignore */ } audioOn = false; }
function testBell() {
  const blob = buildWav(8, [{ t: 0.2, gain: 0.8 }]);
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(blob); audio.src = audioUrl;
  audio.play().catch(e => toast('Звук не играет: ' + e.message));
}

// ===== ВИБРО: пуш-уведомления с сервера =====
// iOS не даёт сайтам вибрировать; уведомление приходит и вибрирует даже на заблокированном экране.
// Работает только в приложении, добавленном на экран «Домой» (iOS 16.4+).
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function b64uToBytes(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(s + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
async function pushSub() { if (!pushSupported()) return null; const reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); }
async function enablePush() {
  if (!pushSupported()) { toast(isStandalone() ? 'Этот телефон не поддерживает уведомления (нужна iOS 16.4+)' : 'Сначала добавь приложение на экран «Домой» и открой оттуда'); return false; }
  const perm = await Notification.requestPermission();   // первым await — пока жив жест пользователя
  log('INFO', 'notification permission', perm);
  if (perm !== 'granted') { toast('Уведомления запрещены — включи в Настройках iOS → Уведомления'); return false; }
  const { key } = await fetch(CONFIG.PUSH_API + '/key').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  log('INFO', 'push subscribed', { host: new URL(sub.endpoint).host });
  S().pushEnabled = true; saveState();
  return true;
}
async function schedulePush(jobs) {
  if (!S().pushEnabled) return;
  try {
    const sub = await pushSub();
    if (!sub) { log('WARNING', 'push: нет подписки'); return; }
    const r = await fetch(CONFIG.PUSH_API + '/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint, jobs }) });
    log(r.ok ? 'INFO' : 'WARNING', 'push schedule', { status: r.status, jobs: jobs.map(j => ({ tag: j.tag, inSec: Math.round((j.at - Date.now()) / 1000) })) });
    if (!r.ok && jobs.length) toast('Вибро не запланировано: сервер ответил ' + r.status);
  } catch (e) { log('WARNING', 'push schedule failed', e.message); if (jobs.length) toast('Вибро не запланировано: нет связи'); }
}
// Расписание пушей для идущей базовой практики (пересчитывается при старте, паузе, переходе).
function pushJobsForActive() {
  const a = active;
  if (!a || a.kind !== 'base' || a.pausedAt) return [];
  const left = (a.phaseSec - phaseElapsed(a)) * 1000, now = Date.now();
  return a.phase === 'walk'
    ? [{ at: Math.round(now + left), tag: 'walk_end' }, { at: Math.round(now + left + a.phaseSec * 1000), tag: 'end' }]
    : [{ at: Math.round(now + left), tag: 'end' }];
}
const syncPush = () => schedulePush(pushJobsForActive());

// ===== ЭКРАН НЕ ГАСНЕТ =====
let wakeLock = null;
async function lockScreenOn() {
  if (!S().keepScreenOn || !('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); log('DEBUG', 'wakeLock on'); }
  catch (e) { log('WARNING', 'wakeLock failed', e.message); }
}
function releaseScreen() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }

// ===== АКТИВНАЯ СЕССИЯ (с чекпоинтом в localStorage) =====
// base: { kind, id, start, phaseSec, phase:'walk'|'sit', phaseStart, pausedAccum, pausedAt, walkSec }
// puto: { kind, id, start, pausedAccum, pausedAt }
let active = loadActive();
function loadActive() {
  try { const a = JSON.parse(localStorage.getItem(CONFIG.ACTIVE_KEY) || 'null'); if (a) log('INFO', 'active session restored', a); return a; }
  catch (e) { log('ERROR', 'active load failed', e.message); return null; }
}
function saveActive() {
  try { active ? localStorage.setItem(CONFIG.ACTIVE_KEY, JSON.stringify(active)) : localStorage.removeItem(CONFIG.ACTIVE_KEY); }
  catch (e) { log('ERROR', 'active save failed', e.message); }
}
const pausedMs = (a, now = Date.now()) => a.pausedAccum + (a.pausedAt ? now - a.pausedAt : 0);
const phaseElapsed = (a, now = Date.now()) => Math.max(0, (now - (a.kind === 'base' ? a.phaseStart : a.start) - pausedMs(a, now)) / 1000);

function startBase(min) {
  if (active) { toast('Уже идёт сессия'); return; }
  const now = Date.now();
  active = { kind: 'base', id: uid(), start: now, phaseSec: min * 60, phase: 'walk', phaseStart: now, pausedAccum: 0, pausedAt: null, walkSec: 0 };
  saveActive();
  log('INFO', 'base start', { min });
  playFromActive();   // строго внутри нажатия — иначе iOS не даст играть звук
  lockScreenOn(); syncPush();
  go('timer');
}
function startPuto() {
  if (active) { toast('Уже идёт сессия'); return; }
  active = { kind: 'puto', id: uid(), start: Date.now(), pausedAccum: 0, pausedAt: null };
  saveActive(); log('INFO', 'puto start'); lockScreenOn(); go('timer');
}
function pauseActive() {
  if (!active || active.pausedAt) return;
  active.pausedAt = Date.now(); saveActive(); stopAudio(); syncPush();
  log('INFO', 'pause', { kind: active.kind }); render();
}
function resumeActive() {
  if (!active || !active.pausedAt) return;
  active.pausedAccum += Date.now() - active.pausedAt; active.pausedAt = null; saveActive();
  log('INFO', 'resume', { kind: active.kind });
  playFromActive(); syncPush(); render();
}
// Ходьба закончилась → сидячая. Учитывает, что телефон мог «спать» и пропустить переход.
function advanceIfDue(now = Date.now()) {
  const a = active;
  if (!a || a.kind !== 'base' || a.pausedAt) return;
  if (a.phase === 'walk' && phaseElapsed(a, now) >= a.phaseSec) {
    a.walkSec = a.phaseSec;
    a.phaseStart = a.phaseStart + a.pausedAccum + a.phaseSec * 1000;
    a.pausedAccum = 0; a.phase = 'sit'; saveActive();
    log('INFO', 'phase → sit (по таймеру)');
  }
  if (a.phase === 'sit' && phaseElapsed(a, now) >= a.phaseSec) finishBase(true);
}
function skipPhase() {
  const a = active;
  if (!a || a.kind !== 'base') return;
  if (a.phase === 'walk') {
    if (a.pausedAt) { a.pausedAccum += Date.now() - a.pausedAt; a.pausedAt = null; }
    a.walkSec = Math.round(phaseElapsed(a));
    a.phase = 'sit'; a.phaseStart = Date.now(); a.pausedAccum = 0; saveActive();
    log('INFO', 'phase → sit (вручную)', { walkSec: a.walkSec });
    playFromActive(); syncPush(); render();
  } else finishBase(false);
}
function finishBase(natural) {
  const a = active; if (!a) return;
  const now = Date.now();
  let walkSec = a.walkSec, sitSec = 0;
  if (a.phase === 'walk') walkSec = Math.min(a.phaseSec, Math.round(phaseElapsed(a, now)));
  else sitSec = Math.min(a.phaseSec, Math.round(phaseElapsed(a, now)));
  if (!natural) { stopAudio(); schedulePush([]); }   // при естественном конце колокол доигрывает, пуш уже ушёл
  active = null; saveActive(); releaseScreen();
  const sec = walkSec + sitSec;
  if (sec < CONFIG.MIN_SAVE_SEC) { log('INFO', 'base too short, not saved', { sec }); toast('Меньше 30 секунд — не сохранено'); go('today'); return; }
  const end = natural ? a.phaseStart + a.pausedAccum + a.phaseSec * 1000 : now;
  const k = dayKey(a.start);
  const s = { id: a.id, kind: 'base', start: a.start, end, sec, walkSec, sitSec, planned: a.phaseSec * 2, gratitude: false };
  ensureDay(k).sessions.push(s); saveState();
  log('INFO', 'base saved', s);
  go('gratitude', { key: k, id: s.id });
}
function finishPuto() {
  const a = active; if (!a) return;
  const sec = Math.round(phaseElapsed(a));
  active = null; saveActive(); releaseScreen();
  if (sec < CONFIG.MIN_SAVE_SEC) { toast('Меньше 30 секунд — не сохранено'); go('today'); return; }
  const k = dayKey(a.start), s = { id: a.id, kind: 'puto', start: a.start, end: Date.now(), sec };
  ensureDay(k).sessions.push(s); saveState();
  log('INFO', 'puto saved', s); toast(`Пу-то: ${fmtClock(sec)} сохранено`); go('today');
}
function cancelActive() {
  if (!active || !confirm('Отменить сессию без сохранения?')) return;
  log('INFO', 'cancel', { kind: active.kind });
  const wasBase = active.kind === 'base';
  stopAudio(); active = null; saveActive(); releaseScreen();
  if (wasBase) schedulePush([]);
  go('today');
}

// Сессия, отмеченная задним числом (без таймера).
function manualSession(k, kind, min, opts = {}) {
  const at = opts.at ?? (dateOfKey(k).getTime() + 12 * 3600e3);
  const s = kind === 'base'
    ? { id: uid(), kind, start: at, end: at + min * 120e3, sec: min * 120, walkSec: min * 60, sitSec: min * 60, planned: min * 120, gratitude: opts.gratitude !== false, manual: true }
    : { id: uid(), kind, start: at, end: at + min * 60e3, sec: min * 60, manual: true };
  ensureDay(k).sessions.push(s);
  log('INFO', 'manual session', s);
  return s;
}

// ===== НАВИГАЦИЯ И РЕНДЕР =====
let view = active ? 'timer' : 'today', viewArg = {};
let selPhaseMin = null, monthOffset = 0;
const app = document.getElementById('app'), tabs = document.getElementById('tabs');
function go(v, arg = {}) { view = v; viewArg = arg; log('DEBUG', 'view', { v, arg }); render(); window.scrollTo(0, 0); }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TAB_OF = { today: 'today', calendar: 'calendar', settings: 'settings', day: 'calendar' };

function render() {
  tabs.classList.toggle('hidden', view === 'timer' || view === 'gratitude');
  tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.arg === TAB_OF[view]));
  const r = { today: rToday, timer: rTimer, gratitude: rGratitude, morning: rMorning, evening: rEvening, log: rLog, calendar: rCalendar, settings: rSettings, day: rDay }[view];
  app.innerHTML = r ? r() : '';
  bindLive();
}

// Живые подписи у ползунков без полной перерисовки (чтобы не терять палец на слайдере).
function bindLive() {
  app.querySelectorAll('input[type=range][data-out]').forEach(r => {
    const upd = () => { app.querySelectorAll(`[data-from="${r.dataset.out}"]`).forEach(o => { o.textContent = o.dataset.mul ? r.value * +o.dataset.mul : r.value; }); };
    r.addEventListener('input', upd);
    if (r.id === 'phasemin') r.addEventListener('change', () => { selPhaseMin = +r.value; });
  });
  app.querySelectorAll('input[type=checkbox][data-reveal]').forEach(c => {
    const t = document.getElementById(c.dataset.reveal);
    const upd = () => { if (t) t.hidden = !c.checked; };
    c.addEventListener('change', upd); upd();
  });
}

function streakPills() {
  return `<div class="pills">
    <span class="pill warm">${icon('flame')} практика ${practiceStreak()}</span>
    <span class="pill green">${icon('leaf')} трезвость ${soberStreak()}</span>
  </div>`;
}

function rToday() {
  const k = dayKey(), d = getDay(k), st = S();
  const base = sumSec(k, 'base'), puto = sumSec(k, 'puto'), goal = goalSec(k);
  const pm = programMin(k), sel = selPhaseMin ?? pm, week = programWeek(k) + 1;
  const hour = new Date().getHours();
  const eveningOpen = hour >= st.eveningFromHour || hour < st.dayStartHour || d.evening;
  const y = addDays(k, -1), yd = getDay(y);
  const yOpen = !habitsDone(y) && (Object.keys(state.days).some(x => x < k) || yd.sessions.length);
  const sessions = d.sessions.filter(s => s.kind === 'base');
  return `
  <div class="head"><div><p class="muted small">Сегодня</p><h1>${esc(cap(fmtDay(k)))}</h1></div></div>
  ${streakPills()}
  ${yOpen ? `<button class="banner" data-act="evening" data-arg="${y}">${icon('moon')}<span class="grow"><b>Вчера не закрыто</b><br><span class="small">Отметь практики и привычки за ${esc(fmtShort(y))}</span></span>›</button>` : ''}

  <div class="card">
    <div class="card-h">${icon('sun')}<h2 class="grow">Утро</h2>
      ${d.morning ? `<span class="done">${icon('check')}готово</span>` : ''}</div>
    ${d.morning ? `<p class="muted small">${moodLine(d.morning)}</p>${tasksOf(k).length ? `<ol class="tasks">${tasksOf(k).map(x => `<li>${esc(x.text)}</li>`).join('')}</ol>` : ''}
      <button class="btn ghost mt" data-act="go" data-arg="morning">Изменить</button>`
      : `<button class="btn" data-act="go" data-arg="morning">Утренняя рефлексия</button>`}
  </div>

  <div class="card">
    <div class="card-h"><span class="phases">${icon('walk')}${icon('sit')}${icon('thanks')}</span><h2 class="grow">Базовая практика</h2>
      <span class="muted small">${Math.round(base / 60)} / ${goal / 60} мин</span></div>
    <div class="bar"><i style="width:${Math.min(100, base / goal * 100)}%"></i></div>
    <div class="slider-h"><span class="muted small">На каждую часть</span><span class="val"><b data-from="pm">${sel}</b> мин</span></div>
    <input type="range" id="phasemin" data-out="pm" min="1" max="${CONFIG.SLIDER_MAX_MIN}" step="1" value="${sel}">
    <p class="muted small">Неделя ${week} программы · сейчас ${pm} + ${pm} мин${pm >= st.programMaxMin ? ' (потолок)' : ', в понедельник +' + st.programStepMin}</p>
    <button class="btn primary mt" data-act="startbase">${icon('play')} Начать · <span data-from="pm">${sel}</span> + <span data-from="pm">${sel}</span> мин</button>
    ${sessions.length ? `<ul class="list">${sessions.map(s => sessionRow(s)).join('')}</ul>` : ''}
    <button class="link" data-act="log" data-arg="base|${k}">${icon('plus')} Отметить без таймера</button>
  </div>

  <div class="card">
    <div class="card-h">${icon('puto')}<h2 class="grow">Пу-то</h2>
      <span class="muted small">${puto ? fmtClock(puto) : 'не было'}</span></div>
    <button class="btn" data-act="startputo">${icon('play')} Старт пу-то</button>
    <button class="link" data-act="log" data-arg="puto|${k}">${icon('plus')} Отметить без секундомера</button>
  </div>

  <div class="card">
    <div class="card-h">${icon('moon')}<h2 class="grow">Итог дня</h2>
      ${habitsDone(k) ? `<span class="done">${icon('check')}готово</span>` : ''}</div>
    ${d.evening ? `<p class="muted small">${[moodLine(d.evening), tasksLine(k), `дыхание ${d.evening.breath}%`, habitsLine(k)].filter(Boolean).join(' · ')}</p>
      <button class="btn ghost mt" data-act="evening" data-arg="${k}">Изменить</button>`
      : eveningOpen ? `<button class="btn" data-act="evening" data-arg="${k}">Подвести итог дня</button>`
      : `<p class="muted small">Откроется в ${pad(st.eveningFromHour)}:00 · <a href="#" data-act="evening" data-arg="${k}">заполнить сейчас</a></p>`}
  </div>`;
}
function habitsLine(k) {
  if (!habitsDone(k)) return 'привычки не отмечены';
  const u = usedHabits(k);
  return u.length ? u.map(x => x.name.toLowerCase()).join(', ') : 'чистый день';
}
function sessionRow(s, withDelete = false, key = '') {
  const on = (cond, n) => cond ? `<span class="on">${icon(n)}</span>` : icon(n);
  const ic = s.kind === 'base'
    ? `<span class="phases">${on(s.walkSec, 'walk')}${on(s.sitSec, 'sit')}${on(s.gratitude, 'thanks')}</span>`
    : `<span class="phases"><span class="on">${icon('puto')}</span></span>`;
  const det = s.kind === 'base' ? `${fmtMin(s.walkSec)} + ${fmtMin(s.sitSec)}` : s.manual ? fmtMin(s.sec) : fmtClock(s.sec);
  return `<li>${ic}<span class="grow">${s.manual ? 'без таймера' : fmtTime(s.start)} · ${det}</span>${withDelete ? `<button class="x" aria-label="Удалить" data-act="delsession" data-arg="${key}|${s.id}">×</button>` : ''}</li>`;
}

function rTimer() {
  const a = active;
  if (!a) return `<p class="center muted mt">Нет активной сессии</p><button class="btn mt" data-act="tab" data-arg="today">На главную</button>`;
  const names = S().phaseNames;
  if (a.kind === 'puto') {
    const e = phaseElapsed(a);
    return `<div class="timer">
      <div class="steps"><div class="on">${icon('puto', 'big')}<span>Пу-то</span></div></div>
      ${ring((e % 60) / 60, fmtClock(e), a.pausedAt ? 'пауза' : 'идёт')}
      <div class="puto" id="puto">пу · то</div>
      <p class="muted small">Правой — «пу», левой — «то». Других мыслей нет.</p>
      <div class="row2" style="width:100%">
        ${a.pausedAt ? `<button class="btn" data-act="resume">${icon('play')} Продолжить</button>` : `<button class="btn" data-act="pause">${icon('pause')} Пауза</button>`}
        <button class="btn primary" data-act="finishputo">${icon('stop')} Финиш</button>
      </div>
      <button class="btn ghost danger" data-act="cancel">Отменить</button>
    </div>`;
  }
  const pe = phaseElapsed(a), left = a.phaseSec - pe, idx = a.phase === 'walk' ? 0 : 1;
  const step = i => `<div class="${i === idx ? 'on' : i < idx ? 'past' : ''}">${icon(PHASE_ICON[i], 'big')}<span>${esc(names[i])}</span></div>`;
  return `<div class="timer">
    <div class="steps">${step(0)}${step(1)}${step(2)}</div>
    ${ring(Math.min(1, pe / a.phaseSec), fmtClock(left), a.pausedAt ? 'пауза' : esc(names[idx]).toLowerCase())}
    ${!a.pausedAt && !audioOn ? `<div class="note">Звук не играет — колокол не прозвучит при заблокированном экране.<button class="btn mt" data-act="audioon">${icon('bell')} Включить звук</button></div>` : ''}
    <p class="muted small">${idx === 0 ? `Затем ${esc(names[1]).toLowerCase()} ${Math.round(a.phaseSec / 60)} мин и благодарность` : 'Затем благодарность'} · экран можно заблокировать${S().pushEnabled ? ' · вибро включено' : ''}</p>
    <div class="row2" style="width:100%">
      ${a.pausedAt ? `<button class="btn" data-act="resume">${icon('play')} Продолжить</button>` : `<button class="btn" data-act="pause">${icon('pause')} Пауза</button>`}
      <button class="btn" data-act="skip">${icon('next')} ${idx === 0 ? esc(names[1]) : 'Завершить'}</button>
    </div>
    <button class="btn ghost danger" data-act="cancel">Отменить</button>
  </div>`;
}
function ring(frac, big, small) {
  const r = 120, c = 2 * Math.PI * r;
  return `<div class="ring"><svg viewBox="0 0 260 260"><circle cx="130" cy="130" r="${r}" fill="none" stroke="var(--card2)" stroke-width="8"/>
    <circle cx="130" cy="130" r="${r}" fill="none" stroke="var(--accent)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - frac)).toFixed(1)}"/></svg>
    <div class="t"><div class="num" id="num">${big}</div><div class="muted small">${small}</div></div></div>`;
}

function rGratitude() {
  const s = getDay(viewArg.key).sessions.find(x => x.id === viewArg.id), n = S().phaseNames;
  return `<div class="timer" style="padding-top:40px">
    <div class="steps"><div class="past">${icon('walk', 'big')}<span>${esc(n[0])}</span></div><div class="past">${icon('sit', 'big')}<span>${esc(n[1])}</span></div><div class="on">${icon('thanks', 'big')}<span>${esc(n[2])}</span></div></div>
    <div style="color:var(--accent);margin-top:24px">${icon('thanks', 'huge')}</div>
    <h1>${esc(S().gratitudePrompt)}</h1>
    ${s ? `<p class="muted">${esc(n[0])} ${fmtMin(s.walkSec)} · ${esc(n[1]).toLowerCase()} ${fmtMin(s.sitSec)}</p>` : ''}
    <button class="btn primary mt" data-act="gratitude" data-arg="yes">${icon('check')} Поблагодарил</button>
    <button class="btn ghost" data-act="gratitude" data-arg="no">Пропустить</button>
  </div>`;
}

// Шкала 1–5 (настроение / энергия).
function scaleBlock(id, v) {
  const sc = CONFIG.SCALES[id];
  return `<label class="q">${sc.name}</label>
    <div class="scale" id="sc-${id}" data-val="${v || 0}">${[1, 2, 3, 4, 5].map(i => `<button type="button" class="${i === v ? 'on' : ''}" data-act="scale" data-arg="${id}|${i}">${i}</button>`).join('')}</div>
    <p class="small muted scale-l"><span>${sc.lo}</span><span>${sc.hi}</span></p>`;
}
const scaleVal = id => +(val('sc-' + id)?.dataset.val || 0);
const tasksOf = k => (getDay(k).morning?.tasks || []).filter(x => x.text);
function tasksLine(k) {
  const ts = tasksOf(k); if (!ts.length) return '';
  const done = getDay(k).evening?.tasksDone;
  return done ? `дела ${ts.filter((x, i) => done[i]).length}/${ts.length}` : `дел ${ts.length}`;
}
const moodLine = r => r && r.mood ? `настроение ${r.mood} · энергия ${r.energy || '—'}` : '';

function rMorning() {
  const k = viewArg.key || dayKey(), m = getDay(k).morning, qs = S().morningQuestions, n = S().tasksCount;
  const ans = q => m?.answers?.find(x => x.q === q)?.a ?? '';
  const task = i => m?.tasks?.[i]?.text ?? '';
  return `<button class="back" data-act="back">‹ Назад</button>
  <h1>${icon('sun')} Утро</h1><p class="muted small">${esc(cap(fmtDay(k)))}</p>
  <form id="f" data-key="${k}" data-kind="morning">
    ${scaleBlock('mood', m?.mood)}
    ${scaleBlock('energy', m?.energy)}
    <label class="q">${n} важных дела на сегодня</label>
    ${Array.from({ length: n }, (_, i) => `<div class="task-in"><span class="muted">${i + 1}</span><input type="text" id="t${i}" value="${esc(task(i))}" placeholder="${['Самое важное', 'Второе', 'Третье'][i] || 'Дело'}"></div>`).join('')}
    ${qs.map((q, i) => `<label class="q" for="q${i}">${esc(q)}</label><textarea id="q${i}" data-q="${esc(q)}">${esc(ans(q))}</textarea>`).join('')}
    <p class="small err" id="err"></p>
    <button class="btn primary" type="button" data-act="saveform">Сохранить</button>
  </form>`;
}

// Итог дня: практики задним числом + дыхание + привычки + вопросы.
function rEvening() {
  const k = viewArg.key || dayKey(), d = getDay(k), e = d.evening, qs = S().eveningQuestions;
  const breath = e?.breath ?? 50, base = sumSec(k, 'base'), puto = sumSec(k, 'puto'), pm = programMin(k);
  const h = e?.habits || {};
  const ans = q => e?.answers?.find(x => x.q === q)?.a ?? '';
  const ts = tasksOf(k), done = e?.tasksDone || [];
  const habitRow = x => `<div class="hrow" data-habit="${x.id}"><span class="grow">${esc(x.name)}</span>
    <div class="seg"><button type="button" class="${h[x.id] === false ? 'on' : ''}" data-act="habit" data-arg="${x.id}|0">не было</button><button type="button" class="${h[x.id] === true ? 'on bad' : ''}" data-act="habit" data-arg="${x.id}|1">было</button></div></div>`;
  return `<button class="back" data-act="back">‹ Назад</button>
  <h1>${icon('moon')} Итог дня</h1><p class="muted small">${esc(cap(fmtDay(k)))}</p>
  <form id="f" data-key="${k}" data-kind="evening">
    <div class="card mt">
      <div class="card-h">${icon('check')}<h2 class="grow">Дела дня</h2></div>
      ${ts.length ? ts.map((x, i) => `<label class="chk task"><input type="checkbox" id="td${i}" ${done[i] ? 'checked' : ''}> ${esc(x.text)}</label>`).join('')
        : `<p class="muted small">Утром дела не записаны.${k === dayKey() ? ' <a href="#" data-act="morningfor" data-arg="' + k + '">Записать</a>' : ''}</p>`}
    </div>
    <div class="card">
      ${scaleBlock('mood', e?.mood)}
      ${scaleBlock('energy', e?.energy)}
    </div>
    <div class="card">
      <div class="card-h"><span class="phases">${icon('walk')}${icon('sit')}${icon('thanks')}</span><h2 class="grow">Базовая практика</h2></div>
      ${base ? `<p class="done">${icon('check')} ${fmtMin(base)} по таймеру</p>` : `
      <label class="chk"><input type="checkbox" id="mb" data-reveal="mb-box"> Делал без телефона</label>
      <div id="mb-box" hidden>
        <div class="slider-h"><span class="muted small">На каждую часть</span><span class="val"><b data-from="mbm">${pm}</b> мин</span></div>
        <input type="range" id="mbm" data-out="mbm" min="1" max="${CONFIG.SLIDER_MAX_MIN}" step="1" value="${pm}">
        <label class="chk"><input type="checkbox" id="mbg" checked> Благодарность была</label>
      </div>`}
    </div>
    <div class="card">
      <div class="card-h">${icon('puto')}<h2 class="grow">Пу-то</h2></div>
      ${puto ? `<p class="done">${icon('check')} ${fmtClock(puto)} по секундомеру</p>` : `
      <label class="chk"><input type="checkbox" id="mp" data-reveal="mp-box"> Делал без секундомера</label>
      <div id="mp-box" hidden>
        <div class="slider-h"><span class="muted small">Примерно</span><span class="val"><b data-from="mpm">${CONFIG.PUTO_DEFAULT_MIN}</b> мин</span></div>
        <input type="range" id="mpm" data-out="mpm" min="1" max="${CONFIG.PUTO_MAX_MIN}" step="1" value="${CONFIG.PUTO_DEFAULT_MIN}">
      </div>`}
    </div>
    <div class="card">
      <div class="card-h">${icon('breath')}<h2 class="grow">Дыхание 50/50</h2></div>
      <p class="muted small">Какую часть дня удавалось держать половину внимания на дыхании?</p>
      <div class="big-pct"><span data-from="br">${breath}</span>%</div>
      <input type="range" id="breath" data-out="br" min="0" max="100" step="5" value="${breath}">
    </div>
    <div class="card">
      <div class="card-h">${icon('leaf')}<h2 class="grow">Привычки</h2><button type="button" class="chip" data-act="allclean">Всё чисто</button></div>
      ${CONFIG.HABITS.map(habitRow).join('')}
    </div>
    ${qs.map((q, i) => `<label class="q" for="q${i}">${esc(q)}</label><textarea id="q${i}" data-q="${esc(q)}">${esc(ans(q))}</textarea>`).join('')}
    <p class="small err" id="err"></p>
    <button class="btn primary" type="button" data-act="saveform">Сохранить итог</button>
  </form>`;
}

// Отметить практику без таймера (любой день).
function rLog() {
  const kind = viewArg.kind || 'base', k = viewArg.key || dayKey(), today = dayKey();
  const chips = [0, -1, -2].map(i => { const x = addDays(today, i); return `<button type="button" class="chip ${x === k ? 'on' : ''}" data-act="logday" data-arg="${x}">${i === 0 ? 'Сегодня' : i === -1 ? 'Вчера' : 'Позавчера'}</button>`; }).join('');
  const pm = programMin(k);
  return `<button class="back" data-act="back">‹ Назад</button>
  <h1>Отметить без таймера</h1>
  <p class="muted small">Если практика была, а телефона под рукой — нет.</p>
  <label class="q">День</label>
  <div class="chips">${chips}<input type="date" id="logdate" value="${k}" max="${today}" style="width:auto;flex:1;min-width:140px"></div>
  <label class="q">Что</label>
  <div class="seg wide"><button type="button" class="${kind === 'base' ? 'on' : ''}" data-act="logkind" data-arg="base">${icon('sit')} Базовая</button><button type="button" class="${kind === 'puto' ? 'on' : ''}" data-act="logkind" data-arg="puto">${icon('puto')} Пу-то</button></div>
  ${kind === 'base' ? `
    <div class="slider-h mt"><span class="muted small">На каждую часть</span><span class="val"><b data-from="lm">${pm}</b> мин</span></div>
    <input type="range" id="lm" data-out="lm" min="1" max="${CONFIG.SLIDER_MAX_MIN}" step="1" value="${pm}">
    <p class="muted small">Всего <span data-from="lm" data-mul="2">${pm * 2}</span> мин</p>
    <label class="chk"><input type="checkbox" id="lg" checked> Благодарность была</label>`
  : `
    <div class="slider-h mt"><span class="muted small">Примерно</span><span class="val"><b data-from="lm">${CONFIG.PUTO_DEFAULT_MIN}</b> мин</span></div>
    <input type="range" id="lm" data-out="lm" min="1" max="${CONFIG.PUTO_MAX_MIN}" step="1" value="${CONFIG.PUTO_DEFAULT_MIN}">`}
  <p class="small err" id="err"></p>
  <button class="btn primary" data-act="savelog" data-arg="${kind}">Сохранить</button>`;
}

function rCalendar() {
  const today = dayKey();
  let week = 0, br = [], md = [], en = [], tDone = 0, tAll = 0;
  for (let i = 0; i < 7; i++) {
    const k = addDays(today, -i), d = getDay(k), e = d.evening; week += sumSec(k, 'base');
    if (e) br.push(e.breath);
    for (const r of [d.morning, e]) { if (r?.mood) md.push(r.mood); if (r?.energy) en.push(r.energy); }
    if (e?.tasksDone) { tAll += tasksOf(k).length; tDone += tasksOf(k).filter((_, j) => e.tasksDone[j]).length; }
  }
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const avgBr = br.length ? Math.round(avg(br)) : null, f1 = x => x === null ? '—' : x.toFixed(1);
  const ref = dateOfKey(today); ref.setDate(1); ref.setMonth(ref.getMonth() + monthOffset);
  const y = ref.getFullYear(), m = ref.getMonth(), first = new Date(y, m, 1), daysIn = new Date(y, m + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<span class="empty"></span>';
  for (let d = 1; d <= daysIn; d++) {
    const k = keyOfDate(new Date(y, m, d)), b = sumSec(k, 'base'), p = sumSec(k, 'puto'), g = goalSec(k);
    const lvl = b <= 0 ? '' : b >= g ? 'l4' : b >= g * 0.66 ? 'l3' : b >= g * 0.33 ? 'l2' : 'l1';
    const hab = habitsDone(k) ? (isSober(k) ? '<i class="h clean"></i>' : usedHabits(k).map(x => `<i class="h">${x.short}</i>`).join('')) : '';
    cells += `<button class="${lvl} ${k === today ? 'today' : ''} ${k > today ? 'future' : ''}" data-act="day" data-arg="${k}">
      <span class="hab">${hab}</span><span class="n">${d}</span><span class="pr">${p ? '<i class="p"></i>' : ''}</span></button>`;
  }
  const monthName = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(first);
  return `<div class="head"><h1>Календарь</h1></div>
  <div class="tiles">
    <div class="tile"><p class="muted small">${icon('flame')} Практика</p><p class="v">${practiceStreak()}</p><p class="muted small">лучший ${bestStreak(hasBase)}</p></div>
    <div class="tile"><p class="muted small">${icon('leaf')} Трезвость</p><p class="v">${soberStreak()}</p><p class="muted small">лучший ${bestStreak(isSober)}</p></div>
  </div>
  <p class="muted small without">${CONFIG.HABITS.map(x => `без ${x.name === 'Марихуана' ? 'травы' : x.name === 'Алкоголь' ? 'алкоголя' : 'никотина'}: <b>${dni(daysWithout(x.id))}</b>`).join(' · ')}</p>
  <div class="card">
    <div class="monthnav"><button data-act="month" data-arg="-1" aria-label="Предыдущий месяц">‹</button><h2>${cap(monthName)}</h2><button data-act="month" data-arg="1" aria-label="Следующий месяц">›</button></div>
    <div class="cal">${['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map(w => `<div class="wd">${w}</div>`).join('')}${cells}</div>
    <div class="legend">
      <span><i class="sw" style="background:var(--l2)"></i>базовая</span><span><i class="sw" style="background:var(--l4)"></i>цель дня</span>
      <span><i class="p"></i>пу-то</span><span><i class="h clean"></i>чистый день</span>
      <span>${CONFIG.HABITS.map(x => `<i class="h">${x.short}</i>`).join('')} ${CONFIG.HABITS.map(x => x.name.toLowerCase()).join(', ')}</span>
    </div>
  </div>
  <div class="tiles">
    <div class="tile"><p class="muted small">Базовая, 7 дней</p><p class="v">${Math.round(week / 60)}<span class="small muted"> мин</span></p></div>
    <div class="tile"><p class="muted small">${icon('breath')} Дыхание, 7 дней</p><p class="v">${avgBr === null ? '—' : avgBr + '%'}</p></div>
    <div class="tile"><p class="muted small">Настроение / энергия</p><p class="v">${f1(avg(md))}<span class="small muted"> / ${f1(avg(en))}</span></p></div>
    <div class="tile"><p class="muted small">${icon('check')} Дела, 7 дней</p><p class="v">${tAll ? tDone + '<span class="small muted"> из ' + tAll + '</span>' : '—'}</p></div>
  </div>
  <div class="card"><div class="card-h">${icon('breath')}<h2 class="grow">Дыхание 50/50, 30 дней</h2></div>${breathSpark(today)}</div>`;
}
function breathSpark(today) {
  const pts = [];
  for (let i = 29; i >= 0; i--) { const e = getDay(addDays(today, -i)).evening; if (e) pts.push([29 - i, e.breath]); }
  if (pts.length < 2) return '<p class="muted small">Появится после двух итогов дня.</p>';
  const W = 300, H = 80, x = i => (i / 29) * (W - 8) + 4, yv = v => H - 6 - (v / 100) * (H - 12);
  const path = pts.map(([i, v], j) => `${j ? 'L' : 'M'}${x(i).toFixed(1)},${yv(v).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" x2="${W}" y1="${yv(50)}" y2="${yv(50)}" stroke="var(--line)" stroke-dasharray="3 3"/>
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${pts.map(([i, v]) => `<circle cx="${x(i)}" cy="${yv(v)}" r="2.5" fill="var(--accent)"/>`).join('')}</svg>
    <p class="muted small">Пунктир — 50%. Последнее: ${pts[pts.length - 1][1]}%</p>`;
}

function rDay() {
  const k = viewArg.key, d = getDay(k), today = dayKey();
  const qa = r => (r.answers || []).filter(x => x.a).map(x => `<p><span class="qq">${esc(x.q)}</span><br>${esc(x.a).replace(/\n/g, '<br>')}</p>`).join('');
  const future = k > today;
  return `<button class="back" data-act="tab" data-arg="calendar">‹ Календарь</button>
  <h1>${esc(cap(fmtDay(k)))}</h1>
  <p class="muted small">Программа: ${programMin(k)} + ${programMin(k)} мин</p>
  <div class="card mt"><div class="card-h"><h2 class="grow">Практики</h2></div>
    ${d.sessions.length ? `<ul class="list">${d.sessions.slice().sort((a, b) => a.start - b.start).map(s => sessionRow(s, true, k)).join('')}</ul>` : '<p class="muted small">Практик нет.</p>'}
    ${future ? '' : `<button class="link" data-act="log" data-arg="base|${k}">${icon('plus')} Отметить без таймера</button>`}
  </div>
  <div class="card"><div class="card-h">${icon('moon')}<h2 class="grow">Итог дня</h2></div>
    ${d.evening ? `<div class="qa"><p class="muted small">${[moodLine(d.evening), `дыхание 50/50 — ${d.evening.breath}%`, habitsLine(k)].filter(Boolean).join(' · ')}</p>${qa(d.evening)}</div>` : '<p class="muted small">Не заполнено.</p>'}
    ${future ? '' : `<button class="btn ghost mt" data-act="evening" data-arg="${k}">${icon('pen')} ${d.evening ? 'Изменить' : 'Заполнить'}</button>`}</div>
  <div class="card"><div class="card-h">${icon('sun')}<h2 class="grow">Утро</h2></div>
    ${d.morning ? `<div class="qa"><p class="muted small">${moodLine(d.morning)}</p>${tasksOf(k).length ? `<ul class="list">${tasksOf(k).map((x, i) => `<li>${d.evening?.tasksDone?.[i] ? `<span class="on">${icon('check')}</span>` : `<span class="muted">${icon('stop')}</span>`}<span class="grow">${esc(x.text)}</span></li>`).join('')}</ul>` : ''}${qa(d.morning)}</div>` : '<p class="muted small">Не заполнено.</p>'}
    ${future ? '' : `<button class="btn ghost mt" data-act="morningfor" data-arg="${k}">${icon('pen')} ${d.morning ? 'Изменить' : 'Заполнить'}</button>`}</div>`;
}

function rSettings() {
  const st = S(), pushOk = pushSupported();
  return `<div class="head"><h1>Настройки</h1></div>
  <div class="card">
    <div class="card-h">${icon('vibe')}<h2 class="grow">Вибро</h2></div>
    <p class="muted small">Уведомление в конце ходьбы и в конце практики — с вибрацией и звуком системы, даже на заблокированном экране. ${pushOk ? '' : isStandalone() ? 'Этот телефон не поддерживает уведомления (нужна iOS 16.4+).' : 'Работает только в приложении, открытом с экрана «Домой».'}</p>
    <label class="chk"><input type="checkbox" id="s-push" ${st.pushEnabled ? 'checked' : ''} ${pushOk ? '' : 'disabled'} data-act="togglepush"> Вибро-уведомления</label>
    ${st.pushEnabled ? `<button class="btn mt" data-act="testpush">${icon('vibe')} Проверить: уведомление через 10 с</button><p class="muted small mt">Нажми и заблокируй экран.</p>` : ''}
  </div>
  <div class="card">
    <div class="card-h">${icon('sit')}<h2 class="grow">Программа</h2></div>
    <p class="muted small">Минут на каждую часть; растёт каждый понедельник до потолка. Сейчас неделя ${programWeek() + 1}: ${programMin()} + ${programMin()} мин.</p>
    <label class="q" for="s-pstart">Старт программы (понедельник)</label><input type="date" id="s-pstart" value="${st.programStart}">
    <div class="row2"><div><label class="q" for="s-pmin">Начало</label><input type="number" id="s-pmin" value="${st.programStartMin}"></div>
      <div><label class="q" for="s-pmax">Потолок</label><input type="number" id="s-pmax" value="${st.programMaxMin}"></div>
      <div><label class="q" for="s-pstep">+ в неделю</label><input type="number" id="s-pstep" value="${st.programStepMin}"></div></div>
  </div>
  <div class="card">
    <label class="q" for="s-names">Названия частей (через запятую)</label><input type="text" id="s-names" value="${esc(st.phaseNames.join(', '))}">
    <label class="q" for="s-grat">Подсказка благодарности</label><input type="text" id="s-grat" value="${esc(st.gratitudePrompt)}">
    <div class="row2"><div><label class="q" for="s-day">День начинается, ч</label><input type="number" id="s-day" min="0" max="12" value="${st.dayStartHour}"></div>
      <div><label class="q" for="s-eve">Итог дня с, ч</label><input type="number" id="s-eve" min="12" max="23" value="${st.eveningFromHour}"></div></div>
    <label class="q">Тема</label>
    <div class="seg wide">${[['light', 'Светлая'], ['dark', 'Тёмная'], ['auto', 'Как в системе']].map(([v, n]) => `<button type="button" class="${(st.theme || 'light') === v ? 'on' : ''}" data-act="theme" data-arg="${v}">${n}</button>`).join('')}</div>
    <label class="chk"><input type="checkbox" id="s-wake" ${st.keepScreenOn ? 'checked' : ''}> Не гасить экран во время сессии</label>
    <p class="muted small mt">Настроение, энергия и ${S().tasksCount} дела есть всегда. Ниже — дополнительные вопросы, если нужны.</p>
    <label class="q" for="s-mq">Доп. вопросы утра (по одному в строке)</label><textarea id="s-mq">${esc(st.morningQuestions.join('\n'))}</textarea>
    <label class="q" for="s-eq">Доп. вопросы итога дня (по одному в строке)</label><textarea id="s-eq">${esc(st.eveningQuestions.join('\n'))}</textarea>
    <p class="small err" id="err"></p>
    <button class="btn primary" data-act="savesettings">Сохранить настройки</button>
  </div>
  <div class="card">
    <button class="btn" data-act="testbell">${icon('bell')} Проверить колокол</button>
    <div class="row2 mt"><button class="btn" data-act="export" data-arg="json">Экспорт JSON</button><button class="btn" data-act="export" data-arg="csv">Экспорт CSV</button></div>
    <label class="btn mt" for="imp">Импорт JSON</label><input type="file" id="imp" accept="application/json,.json" style="display:none">
  </div>
  <div class="card"><details><summary>Журнал отладки</summary><pre class="log">${esc(logBuf.slice(-150).join('\n'))}</pre></details>
    <button class="btn ghost danger mt" data-act="wipe">Удалить все данные</button></div>
  <p class="muted small center">Версия 2 · данные хранятся только на этом телефоне. Экспорт — резервная копия.</p>`;
}

// ===== ДЕЙСТВИЯ =====
function showErr(msg) { const e = document.getElementById('err'); if (e) { e.textContent = msg; if (msg) e.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }
const val = id => document.getElementById(id);
function saveForm() {
  const f = val('f'); if (!f) return;
  const k = f.dataset.key, kind = f.dataset.kind;
  const answers = [...f.querySelectorAll('textarea[data-q]')].map(t => ({ q: t.dataset.q, a: t.value.trim() }));
  const mood = scaleVal('mood'), energy = scaleVal('energy');
  if (!mood) return showErr('Отметь настроение от 1 до 5');
  if (!energy) return showErr('Отметь энергию от 1 до 5');
  if (kind === 'morning') {
    const tasks = Array.from({ length: S().tasksCount }, (_, i) => ({ text: (val('t' + i)?.value || '').trim() }));
    ensureDay(k).morning = { ts: Date.now(), mood, energy, tasks, answers };
  } else {
    const habits = {};
    for (const x of CONFIG.HABITS) {
      const row = f.querySelector(`[data-habit="${x.id}"] button.on`);
      if (!row) return showErr(`Отметь привычки: ${x.name.toLowerCase()} — было или не было`);
      habits[x.id] = row.dataset.arg.endsWith('|1');
    }
    if (val('mb')?.checked) manualSession(k, 'base', +val('mbm').value, { gratitude: val('mbg').checked, at: dateOfKey(k).getTime() + 12 * 3600e3 });
    if (val('mp')?.checked) manualSession(k, 'puto', +val('mpm').value, { at: dateOfKey(k).getTime() + 13 * 3600e3 });
    const tasksDone = tasksOf(k).map((_, i) => !!val('td' + i)?.checked);
    ensureDay(k).evening = { ts: Date.now(), mood, energy, tasksDone, breath: +val('breath').value, habits, answers };
  }
  saveState(); log('INFO', `${kind} saved`, { k });
  toast('Сохранено'); back();
}
function back() { const from = viewArg.from || 'today'; if (from === 'day') go('day', { key: viewArg.key }); else go(from); }
function saveSettings() {
  const v = id => val(id).value;
  const names = v('s-names').split(',').map(s => s.trim()).filter(Boolean);
  const num = (id, lo, hi) => { const x = Math.round(+v(id)); return x >= lo && x <= hi ? x : null; };
  const pmin = num('s-pmin', 1, 60), pmax = num('s-pmax', 1, 120), pstep = num('s-pstep', 0, 10), dsh = num('s-day', 0, 12), eve = num('s-eve', 12, 23);
  const pstart = v('s-pstart');
  if (names.length !== 3) return showErr('Нужно три названия частей через запятую');
  if ([pmin, pmax, pstep, dsh, eve].includes(null)) return showErr('Проверь числа: минуты 1–120, прибавка 0–10, часы в пределах');
  if (pmax < pmin) return showErr('Потолок не может быть меньше начала');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pstart)) return showErr('Укажи дату старта программы');
  const mq = v('s-mq').split('\n').map(s => s.trim()).filter(Boolean), eq = v('s-eq').split('\n').map(s => s.trim()).filter(Boolean);
  Object.assign(state.settings, { programStart: mondayOf(pstart), programStartMin: pmin, programMaxMin: pmax, programStepMin: pstep, phaseNames: names,
    gratitudePrompt: v('s-grat').trim() || CONFIG.DEFAULT_SETTINGS.gratitudePrompt, dayStartHour: dsh, eveningFromHour: eve,
    keepScreenOn: val('s-wake').checked, morningQuestions: mq, eveningQuestions: eq });
  selPhaseMin = null; saveState(); log('INFO', 'settings saved', state.settings); toast('Настройки сохранены'); render();
}
function saveLog(kind) {
  const k = val('logdate').value, today = dayKey();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return showErr('Выбери день');
  if (k > today) return showErr('Нельзя отметить будущий день');
  const min = +val('lm').value;
  const at = k === today ? Date.now() - min * (kind === 'base' ? 120e3 : 60e3) : dateOfKey(k).getTime() + 12 * 3600e3;
  manualSession(k, kind, min, { gratitude: kind === 'base' ? val('lg').checked : undefined, at });
  saveState(); toast(`Отмечено: ${kind === 'base' ? 'базовая' : 'пу-то'}, ${esc(fmtShort(k))}`); back();
}
function delSession(arg) {
  const [k, id] = arg.split('|');
  if (!confirm('Удалить эту практику?')) return;
  const d = ensureDay(k); d.sessions = d.sessions.filter(s => s.id !== id); saveState(); log('INFO', 'session deleted', { k, id }); render();
}
async function exportData(fmt) {
  const stamp = dayKey();
  let blob, name;
  if (fmt === 'json') { blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }); name = `practice-${stamp}.json`; }
  else {
    const rows = [['date', 'program_min', 'base_min', 'walk_min', 'sit_min', 'gratitude', 'puto_min', 'mood_am', 'energy_am', 'mood_pm', 'energy_pm', 'tasks', 'tasks_done', 'breath_pct', ...CONFIG.HABITS.map(x => x.id), 'morning', 'evening']];
    for (const k of Object.keys(state.days).sort()) {
      const d = state.days[k], b = d.sessions.filter(s => s.kind === 'base'), h = d.evening?.habits || {};
      const sum = f => Math.round(b.reduce((a, s) => a + (s[f] || 0), 0) / 60);
      const txt = r => r ? r.answers.filter(x => x.a).map(x => `${x.q}: ${x.a}`).join(' | ') : '';
      rows.push([k, programMin(k), sum('sec'), sum('walkSec'), sum('sitSec'), b.some(s => s.gratitude) ? 1 : 0, Math.round(sumSec(k, 'puto') / 60), d.morning?.mood ?? '', d.morning?.energy ?? '', d.evening?.mood ?? '', d.evening?.energy ?? '', tasksOf(k).map(x => x.text).join(' | '), d.evening?.tasksDone ? d.evening.tasksDone.filter(Boolean).length : '', d.evening?.breath ?? '',
        ...CONFIG.HABITS.map(x => typeof h[x.id] === 'boolean' ? +h[x.id] : ''), txt(d.morning), txt(d.evening)]);
    }
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    blob = new Blob(['﻿' + csv], { type: 'text/csv' }); name = `practice-${stamp}.csv`;
  }
  log('INFO', 'export', { fmt, bytes: blob.size });
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; log('WARNING', 'share failed', e.message); }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function importData(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const s = JSON.parse(r.result);
      if (!s || typeof s.days !== 'object') throw new Error('нет поля days');
      if (!confirm(`Заменить текущие данные (${Object.keys(state.days).length} дн.) импортом (${Object.keys(s.days).length} дн.)?`)) return;
      s.settings = { ...CONFIG.DEFAULT_SETTINGS, ...(s.settings || {}) }; s.version = 3;
      if (!s.settings.programStart) s.settings.programStart = mondayOf(dayKey());
      state = s; saveState(); log('INFO', 'import ok', { days: Object.keys(s.days).length }); toast('Импортировано'); render();
    } catch (e) { log('ERROR', 'import failed', e.message); toast('Файл не подошёл: ' + e.message); }
  };
  r.readAsText(file);
}
function setHabit(id, used) {
  const row = app.querySelector(`[data-habit="${id}"]`); if (!row) return;
  row.querySelectorAll('button').forEach(b => { const on = b.dataset.arg.endsWith(used ? '|1' : '|0'); b.classList.toggle('on', on); b.classList.toggle('bad', on && used); });
  showErr('');
}

const ACTIONS = {
  tab: a => go(a), go: a => go(a, { from: view === 'day' ? 'day' : view, key: viewArg.key }), back: () => back(),
  startbase: () => startBase(+(val('phasemin')?.value || programMin())),
  startputo: () => startPuto(),
  pause: () => pauseActive(), resume: () => resumeActive(), skip: () => skipPhase(),
  finishputo: () => finishPuto(), cancel: () => cancelActive(),
  audioon: () => playFromActive(),
  gratitude: a => { const d = ensureDay(viewArg.key), s = d.sessions.find(x => x.id === viewArg.id); if (s) { s.gratitude = a === 'yes'; saveState(); log('INFO', 'gratitude', { v: s.gratitude }); } stopAudio(); toast(a === 'yes' ? 'Практика завершена' : 'Сохранено без благодарности'); go('today'); },
  scale: a => { const [id, v] = a.split('|'), m = val('sc-' + id); m.dataset.val = v; m.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.arg === a)); showErr(''); },
  habit: a => { const [id, v] = a.split('|'); setHabit(id, v === '1'); },
  allclean: () => CONFIG.HABITS.forEach(x => setHabit(x.id, false)),
  saveform: () => saveForm(),
  evening: a => go('evening', { key: a, from: view === 'day' ? 'day' : 'today' }),
  morningfor: a => go('morning', { key: a, from: 'day' }),
  log: a => { const [kind, k] = a.split('|'); go('log', { kind, key: k, from: view === 'day' ? 'day' : 'today' }); },
  logday: a => { viewArg.key = a; render(); },
  logkind: a => { viewArg.kind = a; const d = val('logdate'); if (d) viewArg.key = d.value; render(); },
  savelog: a => saveLog(a),
  month: a => { monthOffset += +a; render(); },
  day: a => go('day', { key: a }),
  delsession: a => delSession(a),
  theme: a => { S().theme = a; saveState(); applyTheme(); log('INFO', 'theme', a); render(); },
  savesettings: () => saveSettings(), testbell: () => testBell(), export: a => exportData(a),
  togglepush: async () => {
    const c = val('s-push');
    if (c.checked) { try { const ok = await enablePush(); if (!ok) c.checked = false; else toast('Вибро включено'); } catch (e) { c.checked = false; log('ERROR', 'enable push failed', e.message); toast('Не удалось включить: ' + e.message); } }
    else { await schedulePush([]); S().pushEnabled = false; saveState(); toast('Вибро выключено'); }
    render();
  },
  testpush: () => { if (active) { toast('Сначала заверши сессию'); return; } schedulePush([{ at: Date.now() + 10000, tag: 'test' }]).then(() => toast('Уведомление через 10 с — заблокируй экран')); },
  wipe: () => { if (confirm('Удалить все данные? Отменить нельзя.') && confirm('Точно? Сначала сделай экспорт.')) { log('WARNING', 'wipe'); state = { version: 3, settings: { ...CONFIG.DEFAULT_SETTINGS, programStart: mondayOf(dayKey()) }, days: {} }; saveState(); render(); } },
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = ACTIONS[el.dataset.act]; if (!fn) return;
  if (el.tagName === 'A') e.preventDefault();
  try { const r = fn(el.dataset.arg); if (r && r.catch) r.catch(err => log('ERROR', 'action failed', { act: el.dataset.act, msg: err.message })); }
  catch (err) { log('ERROR', 'action failed', { act: el.dataset.act, msg: err.message, stack: err.stack }); toast('Ошибка: ' + err.message); }
});
document.addEventListener('change', e => {
  if (e.target.id === 'imp' && e.target.files[0]) importData(e.target.files[0]);
  if (e.target.id === 'logdate' && e.target.value) { viewArg.key = e.target.value; render(); }
});

let toastT;
function toast(msg) { const t = val('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }

// ===== ТИК =====
let putoFlip = 0;
setInterval(() => {
  if (!active) return;
  const wasPhase = active.phase;
  advanceIfDue();
  if (view !== 'timer') return;
  if (!active || active.phase !== wasPhase) { render(); return; }
  const num = val('num'), pe = phaseElapsed(active);
  if (num) num.textContent = active.kind === 'puto' ? fmtClock(pe) : fmtClock(active.phaseSec - pe);
  const arc = app.querySelector('.ring circle:nth-child(2)');
  if (arc) { const c = 2 * Math.PI * 120, f = active.kind === 'puto' ? (pe % 60) / 60 : Math.min(1, pe / active.phaseSec); arc.setAttribute('stroke-dashoffset', (c * (1 - f)).toFixed(1)); }
  const p = val('puto');
  if (p && !active.pausedAt) { const step = Math.floor(Date.now() / 700) % 2; if (step !== putoFlip) { putoFlip = step; p.innerHTML = step ? 'пу · <b>то</b>' : '<b>пу</b> · то'; } }
}, CONFIG.TICK_MS);

document.addEventListener('visibilitychange', () => {
  log('DEBUG', 'visibility', document.visibilityState);
  if (document.visibilityState === 'visible') { advanceIfDue(); if (active) lockScreenOn(); if (view !== 'evening' && view !== 'morning' && view !== 'log' && view !== 'settings') render(); }
});

// ===== СТАРТ =====
if (active) { advanceIfDue(); if (active && active.kind === 'base' && !active.pausedAt) log('WARNING', 'restored without audio — нужен «Включить звук»'); }
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(() => log('DEBUG', 'sw registered')).catch(e => log('WARNING', 'sw failed', e.message));
}
log('INFO', 'app start', { v: 2, view, standalone: isStandalone(), push: S().pushEnabled });
render();
