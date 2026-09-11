/**
 * Drives the real page in headless Chrome over CDP: checks for console errors,
 * then exercises the flows that used to be broken.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { createServer } from 'node:http';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Serve docs/ ourselves on an ephemeral port. A separately-started server on a
// mismatched port silently produces a blank page and a cascade of confusing
// failures, so the suite owns its own.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const docRoot = new URL('./docs/', import.meta.url);
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = new URL(path, docRoot);
  createReadStream(file)
    .on('open', () => res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' }))
    .on('error', () => { res.writeHead(404).end('not found'); })
    .pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_UNDER_TEST = `http://127.0.0.1:${server.address().port}/index.html`;
console.log('serving docs/ at ' + URL_UNDER_TEST);

// A random port keeps a leftover Chrome from an aborted run out of the way.
const PORT = 9400 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'sq-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,1600',
  '--hide-scrollbars',
], { stdio: 'ignore' });

async function targetUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debugging target');
}

const ws = new WebSocket(await targetUrl());
await new Promise(r => (ws.onopen = r));

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pageErrors.push(d.exception?.description || d.text);
  }
};

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => { ${expression} })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');

// Block the geocoder and Firebase so the test is deterministic and offline-safe.
await send('Network.enable');
await send('Network.setBlockedURLs', {
  urls: [
    '*nominatim.openstreetmap.org*',
    '*firebaseio.com*',
    '*googleapis.com/identitytoolkit*',
    '*api.coingecko.com*',
    '*youtube-nocookie.com*',
  ],
});

await send('Page.navigate', { url: URL_UNDER_TEST });
await sleep(4000);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

// ---------------------------------------------------------------- render
check('page renders with demo passport',
  await evaluate(`return document.querySelectorAll('.stamp-card').length`) === 3);

check('map tiles + 3 pins placed',
  await evaluate(`return document.querySelectorAll('.leaflet-marker-icon').length`) === 3);

check('map uses keyless OSM tiles, not Carto dark_all',
  await evaluate(`
    const src = [...document.querySelectorAll('script:not([src])')].map(s => s.textContent).join('\\n');
    const tiles = [...document.querySelectorAll('.leaflet-tile')].map(i => i.src).join(' ');
    return /tileLayer\\('https:\\/\\/\\{s\\}\\.tile\\.openstreetmap\\.org/.test(src)
      && !/basemaps\\.cartocdn/.test(src + tiles);
  `));

check('notches live only on stamp cards',
  await evaluate(`
    const clip = el => el ? getComputedStyle(el).clipPath : 'none';
    const none = v => !v || v === 'none';
    return none(clip(document.querySelector('.panel')))
      && none(clip(document.querySelector('.btn')))
      && none(clip(document.querySelector('.badge')))
      && /polygon/i.test(clip(document.querySelector('.stamp-card')));
  `));

check('header stats populated',
  await evaluate(`return document.getElementById('statTotal').textContent === '3'
                    && document.getElementById('statCountries').textContent === '3'`));

check('badge progress bars rendered',
  await evaluate(`return document.querySelectorAll('.badge-progress[role=progressbar]').length`) === 8);

// An author `display` rule beats the UA rule for [hidden], so anything hidden
// this way must be verified as actually invisible.
check('every [hidden] element is really hidden',
  await evaluate(`
    const shown = [...document.querySelectorAll('[hidden]')]
      .filter(el => el.getBoundingClientRect().height > 0)
      .map(el => el.id || el.className);
    window.__shownHidden = shown;
    return shown.length === 0;
  `),
  (await evaluate(`return (window.__shownHidden || []).join(', ')`)) || '');

check('Clear filters only appears once a filter is active',
  await evaluate(`
    const btn = document.getElementById('clearFiltersBtn');
    const hiddenAtRest = btn.getBoundingClientRect().height === 0;
    const sel = document.getElementById('filterType');
    sel.value = 'Ramen';
    sel.dispatchEvent(new Event('change', { bubbles:true }));
    const shownWhenFiltered = btn.getBoundingClientRect().height > 0;
    document.getElementById('clearFiltersBtn').click();
    return hiddenAtRest && shownWhenFiltered && btn.getBoundingClientRect().height === 0;
  `));

check('pin chip only appears once a pin is dropped',
  await evaluate(`
    const chip = document.getElementById('pinChip');
    const hiddenAtRest = chip.getBoundingClientRect().height === 0;
    document.getElementById('pinCenterBtn').click();
    const shownAfterPin = chip.getBoundingClientRect().height > 0;
    document.getElementById('clearPinBtn').click();
    return hiddenAtRest && shownAfterPin && chip.getBoundingClientRect().height === 0;
  `));

// ---------------------------------------------------------------- BUG 1
// Deleting every stamp used to resurrect DEFAULT_ENTRIES on reload.
await evaluate(`
  localStorage.setItem('slurpquest_entries_v1', '[]');
  localStorage.setItem('slurpquest_seeded_v1', '1');
`);
await send('Page.navigate', { url: URL_UNDER_TEST });
await sleep(2500);
check('BUG FIX: empty passport stays empty after reload',
  await evaluate(`return document.querySelectorAll('.stamp-card').length === 0
                    && /passport is blank/i.test(document.getElementById('cardGrid').textContent)`),
  await evaluate(`return 'cards=' + document.querySelectorAll('.stamp-card').length`));

// ---------------------------------------------------------------- BUG 2
// saveEntries() used to throw away data silently when the quota blew.
check('BUG FIX: quota failure surfaces a toast instead of silent loss',
  await evaluate(`
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function(k){
      if(k === 'slurpquest_entries_v1'){ const e = new Error('quota'); e.name='QuotaExceededError'; throw e; }
      return orig.apply(this, arguments);
    };
    document.getElementById('fabLogBtn').click();
    document.getElementById('restName').value = 'Quota Ramen';
    document.getElementById('restLocation').value = 'Osaka, Japan';
    document.querySelectorAll('.star-picker').forEach(g => g.querySelector('[data-val="4"]').click());
    document.getElementById('entryForm').requestSubmit();
    Storage.prototype.setItem = orig;
    const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ');
    return /storage/i.test(toasts) && /not saved/i.test(toasts);
  `));

// ---------------------------------------------------------------- BUG 3
await evaluate(`localStorage.removeItem('slurpquest_entries_v1');`);
await send('Page.navigate', { url: URL_UNDER_TEST });
await sleep(2500);

// Reset to a clean seeded state for the interaction tests.
await evaluate(`
  localStorage.removeItem('slurpquest_entries_v1');
  localStorage.removeItem('slurpquest_seeded_v1');
`);
await send('Page.navigate', { url: URL_UNDER_TEST });
await sleep(2500);

// ---------------------------------------------------------------- forms
check('inline validation replaces alert() and focuses the bad field',
  await evaluate(`
    document.getElementById('fabLogBtn').click();
    document.getElementById('entryForm').requestSubmit();
    const nameErr = document.getElementById('err-restName').textContent;
    const focused = document.activeElement.id;
    const invalid = document.getElementById('restName').getAttribute('aria-invalid');
    return nameErr.length > 0 && focused === 'restName' && invalid === 'true';
  `));

check('rating errors name the missing categories',
  await evaluate(`
    document.getElementById('restName').value = 'Menya Test';
    document.getElementById('restLocation').value = 'Kyoto, Japan';
    document.getElementById('entryForm').requestSubmit();
    return /Richness, Texture, Vibe/.test(document.getElementById('err-ratings').textContent);
  `));

check('future dates are rejected',
  await evaluate(`
    const d = document.getElementById('visitDate');
    d.value = '2099-01-01';
    document.getElementById('entryForm').requestSubmit();
    return /future/i.test(document.getElementById('err-visitDate').textContent);
  `));

check('star radiogroup responds to arrow keys',
  await evaluate(`
    const g = document.querySelector('.star-picker[data-target="richness"]');
    g.querySelector('[data-val="1"]').focus();
    g.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    g.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    const checked = g.querySelector('[aria-checked="true"]');
    const tabbables = [...g.querySelectorAll('.star-btn')].filter(b => b.tabIndex === 0).length;
    return checked?.dataset.val === '3' && tabbables === 1;
  `));

check('a full submit creates a stamp',
  await evaluate(`
    document.getElementById('visitDate').value = new Date().toISOString().slice(0,10);
    document.querySelectorAll('.star-picker').forEach(g => g.querySelector('[data-val="5"]').click());
    document.getElementById('entryForm').requestSubmit();
    return document.querySelectorAll('.stamp-card').length === 4
        && document.getElementById('statTotal').textContent === '4';
  `));

check('perfect 5-5-5 bowl unlocks a badge with a toast',
  await evaluate(`
    return [...document.querySelectorAll('.toast')].some(t => /Badge unlocked/i.test(t.textContent));
  `));

// ---------------------------------------------------------------- edit
check('NEW: an existing stamp can be edited',
  await evaluate(`
    const card = document.querySelector('.stamp-card');
    const id = card.dataset.id;
    card.querySelector('[data-action="edit"]').click();
    const prefilled = document.getElementById('restName').value.length > 0;
    document.getElementById('restName').value = 'Renamed Bowl';
    document.getElementById('entryForm').requestSubmit();
    const stillFour = document.querySelectorAll('.stamp-card').length === 4;
    const renamed = document.body.textContent.includes('Renamed Bowl');
    return prefilled && stillFour && renamed;
  `));

// ---------------------------------------------------------------- search/sort
check('NEW: search filters the grid',
  await evaluate(`
    const s = document.getElementById('searchInput');
    s.value = 'Renamed';
    s.dispatchEvent(new Event('input', { bubbles:true }));
    return new Promise(r => setTimeout(() => r(
      document.querySelectorAll('.stamp-card').length === 1 &&
      /Showing 1 of 4/.test(document.getElementById('resultCount').textContent)
    ), 350));
  `));

check('no-match state offers a way out',
  await evaluate(`
    const s = document.getElementById('searchInput');
    s.value = 'zzzzznotathing';
    s.dispatchEvent(new Event('input', { bubbles:true }));
    return new Promise(r => setTimeout(() => r(
      /No stamps match/i.test(document.getElementById('cardGrid').textContent) &&
      !!document.querySelector('[data-empty-action="clear"]')
    ), 350));
  `));

check('clear filters restores everything',
  await evaluate(`
    document.querySelector('[data-empty-action="clear"]').click();
    return document.querySelectorAll('.stamp-card').length === 4;
  `));

check('NEW: sort by rating reorders the grid',
  await evaluate(`
    const sel = document.getElementById('sortBy');
    sel.value = 'score-asc';
    sel.dispatchEvent(new Event('change', { bubbles:true }));
    const first = document.querySelector('.stamp-card h3').textContent.trim();
    sel.value = 'score-desc';
    sel.dispatchEvent(new Event('change', { bubbles:true }));
    const last = document.querySelector('.stamp-card h3').textContent.trim();
    return first !== last;
  `));

// ---------------------------------------------------------------- dialogs
check('delete uses a styled confirm and offers Undo',
  await evaluate(`
    const before = document.querySelectorAll('.stamp-card').length;
    document.querySelector('.stamp-card [data-action="delete"]').click();
    return new Promise(r => setTimeout(() => {
      const dlg = document.getElementById('confirmOverlay');
      const isAlertDialog = dlg.querySelector('[role=alertdialog]') !== null;
      const open = dlg.classList.contains('open');
      document.getElementById('confirmOkBtn').click();
      setTimeout(() => {
        const gone = document.querySelectorAll('.stamp-card').length === before - 1;
        const undo = [...document.querySelectorAll('.toast .t-action')].some(b => /undo/i.test(b.textContent));
        r(isAlertDialog && open && gone && undo);
      }, 120);
    }, 120));
  `));

check('Undo restores the deleted stamp',
  await evaluate(`
    const btn = [...document.querySelectorAll('.toast .t-action')].find(b => /undo/i.test(b.textContent));
    btn.click();
    return document.querySelectorAll('.stamp-card').length === 4;
  `));

check('Escape closes a dialog and returns focus to the opener',
  await evaluate(`
    const opener = document.getElementById('fabLogBtn');
    opener.focus();
    opener.click();
    const opened = document.getElementById('modalOverlay').classList.contains('open');
    const focusMoved = document.activeElement.id === 'restName';
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    const closed = !document.getElementById('modalOverlay').classList.contains('open');
    return opened && focusMoved && closed && document.activeElement === opener;
  `));

check('detail modal opens from a card',
  await evaluate(`
    document.querySelector('.stamp-card .card-open').click();
    const o = document.getElementById('detailOverlay');
    const hasEdit = !!o.querySelector('[data-detail-action="edit"]');
    document.getElementById('detailCloseBtn').click();
    return o.classList.contains('open') === false && hasEdit;
  `));

check('traveler rename dialog replaces prompt()',
  await evaluate(`
    document.getElementById('travelerTag').click();
    document.getElementById('travelerNameInput').value = 'Noodle Sensei';
    document.getElementById('travelerSwatches').querySelector('[data-color="#4aa3ff"]').click();
    document.getElementById('travelerForm').requestSubmit();
    return new Promise(r => setTimeout(() => r(
      document.getElementById('travelerName').textContent === 'Noodle Sensei' &&
      document.getElementById('leaderboardList').textContent.includes('Noodle Sensei')
    ), 200));
  `));

check('goal dialog replaces prompt() and presets work',
  await evaluate(`
    document.getElementById('editGoalBtn').click();
    document.querySelector('[data-goal="25"]').click();
    document.getElementById('goalForm').requestSubmit();
    return /\\/ 25/.test(document.getElementById('goalLabel').textContent)
        && document.getElementById('goalBarTrack').getAttribute('aria-valuemax') === '25';
  `));

// ---------------------------------------------------------------- a11y
check('every interactive control is at least 24x24 CSS px (WCAG 2.5.8)',
  await evaluate(`
    const bad = [...document.querySelectorAll('button, select, input:not([type=hidden]), textarea, .section-nav a')]
      // .visually-hidden file inputs are never pointer targets; they are opened
      // by a visible button, which is measured on its own below.
      .filter(el => el.offsetParent !== null
                 && !el.classList.contains('visually-hidden')
                 && !el.closest('.leaflet-container'))
      .map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.width < 24 || r.height < 24))
      .map(({ el, r }) => (el.id || el.className || el.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    window.__badTargets = bad;
    return bad.length === 0;
  `),
  (await evaluate(`return (window.__badTargets || []).join('; ')`)) || '');

check('each hidden file input has a real, large-enough visible trigger',
  await evaluate(`
    // cameraBtn lives inside the entry dialog, so it has to be open to measure.
    document.getElementById('fabLogBtn').click();
    const triggers = { cameraInput: 'cameraBtn', importInput: 'importBtn' };
    const bad = Object.entries(triggers).filter(([input, btn]) => {
      const b = document.getElementById(btn);
      if (!document.getElementById(input) || !b) return true;
      const r = b.getBoundingClientRect();
      return r.height < 24 || r.width < 24;
    }).map(([input]) => input);
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    window.__badTriggers = bad;
    return bad.length === 0;
  `),
  (await evaluate(`return (window.__badTriggers || []).join(', ')`)) || '');

check('no placeholder-only inputs — every field has a real label',
  await evaluate(`
    const unlabelled = [...document.querySelectorAll('input:not([type=hidden]):not([type=file]), select, textarea')]
      .filter(el => {
        if (el.getAttribute('aria-label')) return false;
        if (el.id && document.querySelector('label[for="' + el.id + '"]')) return false;
        if (el.closest('label')) return false;
        return true;
      })
      .map(el => el.id || el.name || el.tagName);
    window.__unlabelled = unlabelled;
    return unlabelled.length === 0;
  `),
  (await evaluate(`return (window.__unlabelled || []).join(', ')`)) || '');

check('all images carry alt text',
  await evaluate(`
    return [...document.images].every(i => i.hasAttribute('alt'));
  `));

check('error containers are pre-rendered so validation causes no layout shift',
  await evaluate(`
    return [...document.querySelectorAll('.field-error')].length >= 6
        && [...document.querySelectorAll('.field-error')].every(e => e.getAttribute('role') === 'alert');
  `));

// Measure real computed colours rather than trusting the token comments.
check('body text meets WCAG AA contrast (4.5:1, or 3:1 for large text)',
  await evaluate(`
    const parse = (c) => c.match(/[\\d.]+/g).slice(0,3).map(Number);
    const lum = (rgb) => {
      const [r,g,b] = rgb.map(v => {
        v /= 255;
        return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
      });
      return 0.2126*r + 0.7152*g + 0.0722*b;
    };
    const ratio = (a,b) => {
      const [l1,l2] = [lum(a), lum(b)].sort((x,y) => y-x);
      return (l1 + 0.05) / (l2 + 0.05);
    };
    // Walk up for the nearest non-transparent background.
    const bgOf = (el) => {
      let n = el;
      while (n) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) {
          const p = parse(c);
          const alpha = (c.match(/[\\d.]+/g) || [])[3];
          // Panels are translucent over a dark page; composite onto near-black.
          if (alpha !== undefined && Number(alpha) < 1) {
            const a = Number(alpha);
            return p.map(v => Math.round(v * a + 10 * (1 - a)));
          }
          return p;
        }
        n = n.parentElement;
      }
      return [8,8,10];
    };
    const failures = [];
    document.querySelectorAll(
      'p, span, div, li, h1, h2, h3, label, small, .b-desc, .card-date, .goal-label, .storage-note, .leaderboard-count'
    ).forEach(el => {
      if (!el.offsetParent || el.closest('.leaflet-container, .modal-overlay:not(.open)')) return;
      const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
      if (!text) return;
      const cs = getComputedStyle(el);
      if (cs.color === 'rgba(0, 0, 0, 0)' || cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)') return;
      const size = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      const need = large ? 3 : 4.5;
      const r = ratio(parse(cs.color), bgOf(el));
      if (r < need) {
        failures.push(el.className || el.tagName + ':' + text.slice(0,22) + ' ' + r.toFixed(2) + ':1 (needs ' + need + ')');
      }
    });
    window.__contrast = [...new Set(failures)];
    return window.__contrast.length === 0;
  `),
  (await evaluate(`return (window.__contrast || []).slice(0,12).join('\\n        ')`)) || '');

check('reduced-motion is honoured in CSS',
  await evaluate(`
    return [...document.styleSheets]
      .filter(s => !s.href)
      .some(s => [...s.cssRules].some(r => r.conditionText && r.conditionText.includes('prefers-reduced-motion')));
  `));

check('keyboard shortcut N opens the log dialog',
  await evaluate(`
    document.body.focus();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',bubbles:true}));
    const open = document.getElementById('modalOverlay').classList.contains('open');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    return open;
  `));

check('shortcuts do not fire while typing in a field',
  await evaluate(`
    const s = document.getElementById('searchInput');
    s.focus();
    s.dispatchEvent(new KeyboardEvent('keydown',{key:'n',bubbles:true}));
    const open = document.getElementById('modalOverlay').classList.contains('open');
    s.blur();
    return open === false;
  `));

// ---------------------------------------------------------------- export
check('NEW: export produces a downloadable passport',
  await evaluate(`
    let captured = null;
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => { captured = blob; return 'blob:stub'; };
    document.getElementById('exportBtn').click();
    URL.createObjectURL = origCreate;
    return captured !== null && captured.type === 'application/json' && captured.size > 200;
  `));

// ------------------------------------------------------------------ desk
check('DESK: Kitchen TV has no YouTube iframe until play is pressed',
  await evaluate(`
    const facade = document.getElementById('ytFacade');
    const before = facade.querySelectorAll('iframe').length === 0
      && !!document.getElementById('ytPlayBtn');
    document.getElementById('ytPlayBtn').click();
    const frame = facade.querySelector('iframe');
    return before
      && !!frame
      && /youtube-nocookie\\.com\\/embed\\/qM1IbmEEjzA/.test(frame.src)
      && /autoplay=1/.test(frame.src)
      && facade.querySelectorAll('iframe').length === 1;
  `));

check('DESK: tape lists BTC ETH SOL and degrades when CoinGecko is blocked',
  await evaluate(`
    const syms = [...document.querySelectorAll('#tickList .tick-sym')].map(el => el.textContent.trim());
    const meta = document.getElementById('tickMeta').textContent;
    return syms.join(' ') === 'BTC ETH SOL'
      && /CoinGecko/i.test(meta);
  `));

// ------------------------------------------------------------------ chat
// Firebase's database + auth hosts are blocked above, so these exercise the
// parts of the lounge that must work with no network at all.

check('CHAT: nothing connects until asked (Spark has 100 connection slots)',
  await evaluate(`
    const gate = document.getElementById('chatGate');
    const live = document.getElementById('chatLive');
    return !gate.hidden && live.hidden
      && /offline/i.test(document.getElementById('chatStatus').textContent);
  `));

check('CHAT: identity defaults to anonymous with no profile set',
  await evaluate(`
    return document.getElementById('chatAnonBadge').textContent.trim() === 'anonymous';
  `));

check('CHAT: mood and emoticon pickers are populated',
  await evaluate(`
    const moods = document.querySelectorAll('#moodGrid .mood-btn').length;
    const emos  = document.querySelectorAll('#emoGrid .emo-btn').length;
    const zones = document.querySelectorAll('#zoneBar .zone-tab').length;
    return moods >= 10 && emos >= 12 && zones >= 5;
  `));

check('CHAT: .help works offline and lists dot commands',
  await evaluate(`
    const log = document.getElementById('chatLog');
    log.replaceChildren();
    document.getElementById('chatHelpBtn').click();
    const t = log.textContent;
    return /\\.nick/.test(t) && /\\.mood/.test(t) && /\\.join/.test(t) && /\\.buzz/.test(t);
  `));

check('CHAT: emoticon tokens render as glyphs, not raw text',
  await evaluate(`
    const log = document.getElementById('chatLog');
    log.replaceChildren();
    document.getElementById('chatInput').value = '.status feeling :) today';
    document.getElementById('chatForm').dispatchEvent(new Event('submit',{cancelable:true}));
    const emo = log.querySelector('.emo');
    return !!emo && emo.textContent === '\\u{1F642}' && emo.title === ':)';
  `));

check('CHAT: hostile nickname text cannot become markup',
  await evaluate(`
    const log = document.getElementById('chatLog');
    log.replaceChildren();
    document.getElementById('chatInput').value = '.ignore <img src=x onerror=alert(1)><b>bold';
    document.getElementById('chatForm').dispatchEvent(new Event('submit',{cancelable:true}));
    // Truncated to the 20-char nickname cap, and present as text rather than markup.
    return log.querySelector('img, b, script') === null
      && log.textContent.includes('<img src=x')
      && window.__xssFired !== true;
  `));

check('CHAT: control characters are stripped from nicknames',
  await evaluate(`
    const input = document.getElementById('chatInput');
    const form  = document.getElementById('chatForm');
    input.value = '.nick Bad\\u0007Nick\\u202Eflip';
    form.dispatchEvent(new Event('submit',{cancelable:true}));
    const shown = document.getElementById('chatMyNick').textContent;
    return !/[\\u0000-\\u001f]/.test(shown) && shown.startsWith('BadNick');
  `));

check('CHAT: guest_ prefix is reserved so anonymous handles cannot be spoofed',
  await evaluate(`
    const log = document.getElementById('chatLog');
    const input = document.getElementById('chatInput');
    const form = document.getElementById('chatForm');
    input.value = '.anon'; form.dispatchEvent(new Event('submit',{cancelable:true}));
    log.replaceChildren();
    input.value = '.nick guest_0001'; form.dispatchEvent(new Event('submit',{cancelable:true}));
    return /reserved/i.test(log.textContent)
      && document.getElementById('chatAnonBadge').textContent.trim() === 'anonymous'
      && document.getElementById('chatMyNick').textContent !== 'guest_0001';
  `));

check('CHAT: setting then clearing a nickname round-trips',
  await evaluate(`
    const input = document.getElementById('chatInput');
    const form  = document.getElementById('chatForm');
    input.value = '.nick Slurpy'; form.dispatchEvent(new Event('submit',{cancelable:true}));
    const named = document.getElementById('chatMyNick').textContent === 'Slurpy'
      && document.getElementById('chatAnonBadge').textContent.trim() === 'nickname';
    input.value = '.anon'; form.dispatchEvent(new Event('submit',{cancelable:true}));
    const anon = /^guest_/.test(document.getElementById('chatMyNick').textContent)
      && document.getElementById('chatAnonBadge').textContent.trim() === 'anonymous';
    return named && anon;
  `));

check('CHAT: the anonymous handle exists before any connection and can be burned',
  await evaluate(`
    const input = document.getElementById('chatInput');
    const form  = document.getElementById('chatForm');
    input.value = '.anon'; form.dispatchEvent(new Event('submit',{cancelable:true}));
    const first = document.getElementById('chatMyNick').textContent;
    input.value = '.newid'; form.dispatchEvent(new Event('submit',{cancelable:true}));
    const second = document.getElementById('chatMyNick').textContent;
    return /^guest_[0-9a-f]{4}$/.test(first) && /^guest_[0-9a-f]{4}$/.test(second) && first !== second;
  `));

check('CHAT: emoticon picker inserts at the caret and updates the counter',
  await evaluate(`
    const input = document.getElementById('chatInput');
    input.value = ''; input.dispatchEvent(new Event('input'));
    document.querySelector('#emoGrid .emo-btn').click();
    const before = input.value;
    const closed = document.getElementById('emoPop').classList.contains('open') === false;
    return before.trim().length > 0 && closed
      && document.getElementById('chatCount').textContent === String(200 - input.value.length);
  `));

check('CHAT: unknown commands are reported, not sent as messages',
  await evaluate(`
    const log = document.getElementById('chatLog');
    log.replaceChildren();
    document.getElementById('chatInput').value = '.notacommand';
    document.getElementById('chatForm').dispatchEvent(new Event('submit',{cancelable:true}));
    return /unknown command/i.test(log.textContent);
  `));

check('CHAT: connecting with Firebase blocked falls back to the gate',
  await (async () => {
    await evaluate(`document.getElementById('chatConnectBtn').click(); true`);
    await sleep(3000);
    return evaluate(`
      const gate = document.getElementById('chatGate');
      const status = document.getElementById('chatStatus').textContent;
      return !gate.hidden && /offline/i.test(status);
    `);
  })());

// Client caps and the deployed rules have to agree or every send is refused.
{
  const rules = JSON.parse(readFileSync(new URL('./database.rules.json', import.meta.url), 'utf8'));
  const msg = rules.rules.msg.$zone.$id;
  const html = readFileSync(new URL('./docs/index.html', import.meta.url), 'utf8');

  const textCap = Number((msg.x['.validate'].match(/length <= (\d+)/) || [])[1]);
  const clientCap = Number((html.match(/const MAX_LEN = (\d+)/) || [])[1]);
  const inputCap = Number((html.match(/id="chatInput"[\s\S]{0,200}?maxlength="(\d+)"/) || [])[1]);
  check('CHAT: message length cap matches rules, constant and input attribute',
    textCap === 200 && clientCap === textCap && inputCap === textCap,
    `rules=${textCap} const=${clientCap} maxlength=${inputCap}`);

  const rateWindow = Number((rules.rules.rate.$uid['.validate'].match(/\+ (\d+)\)/) || [])[1]);
  const clientCooldown = Number((html.match(/const COOLDOWN_MS = (\d+)/) || [])[1]);
  check('CHAT: client cooldown leaves headroom over the rules rate window',
    clientCooldown > rateWindow, `rules=${rateWindow}ms client=${clientCooldown}ms`);

  const readCap = Number((rules.rules.msg.$zone['.read'].match(/limitToLast <= (\d+)/) || [])[1]);
  const history = Number((html.match(/const HISTORY = (\d+)/) || [])[1]);
  check('CHAT: history query stays inside the rules read window',
    history <= readCap, `rules allow <=${readCap}, client asks ${history}`);

  check('CHAT: rules bind each message to a fresh rate stamp via the merged tree',
    /newData\.parent\(\)\.parent\(\)\.parent\(\)\.child\('rate'\)/.test(msg['.validate'])
      && !/root\.child\('rate'\)/.test(JSON.stringify(rules)),
    'rate binding must use newData.parent(), not root, or every write is denied');

  check('CHAT: messages are append-only and authorship is pinned to auth.uid',
    /!data\.exists\(\)/.test(msg['.write'])
      && msg.u['.validate'].includes("auth.uid")
      && msg.$other['.validate'] === false
      && msg.t['.validate'].includes('=== now'));

  check('CHAT: no write rule sits at or above the message collection',
    rules.rules['.write'] === false
      && !('.write' in rules.rules.msg)
      && !('.write' in rules.rules.msg.$zone),
    'a write rule there would let anyone null the whole zone');

  check('CHAT: unbounded reads are refused by the rules',
    /query\.limitToLast != null/.test(rules.rules.msg.$zone['.read'])
      && /query\.limitToLast != null/.test(rules.rules.who.$zone['.read']));
}

// ---------------------------------------------------------------- errors
const realErrors = [...pageErrors, ...consoleErrors].filter(e =>
  !/firebase|firebaseio|identitytoolkit|ERR_BLOCKED|net::|Failed to fetch|installations|auth\//i.test(e)
);
check('no unexpected console or page errors', realErrors.length === 0, realErrors.join('\n        '));

// ---------------------------------------------------------------- screenshots
await evaluate(`
  localStorage.removeItem('slurpquest_entries_v1');
  localStorage.removeItem('slurpquest_seeded_v1');
  localStorage.removeItem('slurpquest_traveler_v1');
  localStorage.removeItem('slurpquest_goal_v1');
`);
await send('Page.navigate', { url: URL_UNDER_TEST });
await sleep(4500);

async function shot(file, opts = {}) {
  if (opts.width) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: opts.width, height: opts.height, deviceScaleFactor: 2,
      mobile: !!opts.mobile,
    });
    await sleep(1200);
  }
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: !!opts.full,
  });
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('  wrote ' + file);
}

await shot('.shots/desktop-full.png', { width: 1320, height: 3000, full: true });
await evaluate(`document.getElementById('fabLogBtn').click();
  document.getElementById('restName').value='Menya Saimi';
  document.getElementById('restLocation').value='Sapporo, Japan';
  document.querySelector('.star-picker[data-target="richness"] [data-val="5"]').click();
  document.querySelector('.star-picker[data-target="texture"] [data-val="4"]').click();
  document.getElementById('entryForm').requestSubmit();`);
await sleep(600);
await shot('.shots/desktop-validation.png', { width: 1320, height: 1000 });
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);
await shot('.shots/mobile.png', { width: 390, height: 1400, mobile: true, full: true });

console.log('\n================ SUMMARY ================');
const failedChecks = results.filter(r => !r.pass);
console.log(`${results.length - failedChecks.length}/${results.length} checks passed`);
if (failedChecks.length) {
  console.log('\nFailures:');
  failedChecks.forEach(r => console.log(` - ${r.name} ${r.detail ? '→ ' + r.detail : ''}`));
}

ws.close();
chrome.kill();
server.close();
process.exit(failedChecks.length ? 1 : 0);
