// 筋トレ記録 PWA 本体
// 画面: カレンダー / 日別記録 / グラフ / 設定

const PARTS = ['胸', '背中', '肩', '腕', '脚', '腹', '体力'];
const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];

const state = {
  tab: 'calendar',        // calendar | day | graph | settings
  calYear: 0,
  calMonth: 0,            // 0-11
  dayDate: null,          // 'YYYY-MM-DD'
  graphPart: null,
  exercises: [],
  sessions: [],           // date 昇順
  timerId: null,
  timerRemain: 0,
  timerEndAt: 0,
};

// ---------- ユーティリティ ----------

function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return dateStr(new Date()); }
function jpWeekday(s) {
  const d = new Date(s + 'T00:00:00');
  return WEEKDAYS[(d.getDay() + 6) % 7];
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function exName(id) {
  const ex = state.exercises.find(e => e.id === id);
  return ex ? ex.name : '(削除済み種目)';
}
function exPart(id) {
  const ex = state.exercises.find(e => e.id === id);
  return ex ? ex.part : 'その他';
}
function exIsBw(id) {
  const ex = state.exercises.find(e => e.id === id);
  return !!(ex && ex.bw);
}
function setsSummary(sets, bw) {
  if (bw) return sets.map(s => s.w > 0 ? `自重+${s.w}kg×${s.r}` : `自重×${s.r}`).join(', ');
  return sets.map(s => `${s.w}kg×${s.r}`).join(', ');
}

async function reloadData() {
  state.exercises = await db.getAll('exercises');
  state.sessions = (await db.getAll('sessions')).sort((a, b) => a.date < b.date ? -1 : 1);
}

function getSession(date) {
  return state.sessions.find(s => s.date === date);
}

// date より前で exId を含む直近セッションのエントリを返す
function prevEntry(exId, date) {
  for (let i = state.sessions.length - 1; i >= 0; i--) {
    const s = state.sessions[i];
    if (s.date >= date) continue;
    const e = s.entries.find(en => en.exId === exId);
    if (e) return { date: s.date, entry: e };
  }
  return null;
}

// エントリの比較指標: 通常種目 = セット最大重量 / 自重種目 = 合計回数
function entryMetric(en, bw) {
  if (!en.sets.length) return null;
  return bw ? en.sets.reduce((sum, x) => sum + x.r, 0) : Math.max(...en.sets.map(x => x.w));
}

// date より前の自己ベスト（セット単位。通常: 最大重量 / 自重: 最大回数）。履歴なしは null
function bestBefore(exId, date, bw) {
  let best = null;
  for (const s of state.sessions) {
    if (s.date >= date) continue;
    const en = s.entries.find(e => e.exId === exId);
    if (!en) continue;
    for (const set of en.sets) {
      const v = bw ? set.r : set.w;
      if (best === null || v > best) best = v;
    }
  }
  return best;
}

// 前回比の差分 + 自己ベスト更新の表示 HTML（日別記録の前回行に付く）
function diffInfoHtml(en, date) {
  const bw = exIsBw(en.exId);
  const prev = prevEntry(en.exId, date);
  const cur = entryMetric(en, bw);
  if (!prev || cur === null) return '<span class="diff-info"></span>';
  const d = Math.round((cur - entryMetric(prev.entry, bw)) * 10) / 10;
  const cls = d > 0 ? 'diff-up' : d < 0 ? 'diff-down' : 'diff-same';
  const unit = bw ? '回' : 'kg';
  const best = bestBefore(en.exId, date, bw);
  const anyPb = best !== null && en.sets.some(s => (bw ? s.r : s.w) > best && (bw ? s.r : s.w) > 0);
  return `<span class="diff-info"><span class="${cls}">今日 ${d > 0 ? '+' : ''}${d}${unit}</span>${anyPb ? '<span class="pb-text">自己ベスト更新</span>' : ''}</span>`;
}

async function saveSession(session) {
  if (session.entries.length === 0) {
    await db.del('sessions', session.date);
  } else {
    // 当日の記録はリアルタイム入力とみなし、実施時刻として保存時刻を残す
    // （過去日の遡及編集では実施時刻を上書きしない）
    if (session.date === todayStr()) session.updatedAt = Date.now();
    await db.put('sessions', session);
  }
  await reloadData();
}

async function getSetting(key, fallback) {
  const row = await db.get('settings', key);
  return row ? row.value : fallback;
}
async function setSetting(key, value) {
  await db.put('settings', { key, value });
}

// ---------- 画面切り替え ----------

const $view = document.getElementById('view');
const $title = document.getElementById('title');
const $back = document.getElementById('back-btn');
const $next = document.getElementById('next-btn');

// 日別記録画面ではヘッダ左右の矢印が前日/翌日ナビになる
// （カレンダーへはタブバーで戻る）。display:none だとタイトルの
// 中央位置がずれるため、幅を保ったまま非表示にする
function setHeader(title, showDayNav) {
  $title.textContent = title;
  $back.classList.toggle('invisible', !showDayNav);
  $next.classList.toggle('invisible', !showDayNav);
}

function render() {
  document.querySelectorAll('#tabbar .tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === (state.tab === 'day' ? 'calendar' : state.tab));
  });
  if (state.tab === 'calendar') renderCalendar();
  else if (state.tab === 'day') renderDay();
  else if (state.tab === 'graph') renderGraph();
  else if (state.tab === 'settings') renderSettings();
}

// タブタップは常に各画面のデフォルト状態に戻す
// （カレンダー: 今月 / グラフ: ALL / 設定: そのまま）
document.querySelectorAll('#tabbar .tab').forEach(b => {
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    if (b.dataset.tab === 'calendar') {
      const now = new Date();
      state.calYear = now.getFullYear();
      state.calMonth = now.getMonth();
    }
    if (b.dataset.tab === 'graph') state.graphPart = 'ALL';
    render();
  });
});

function shiftDate(s, delta) {
  const d = new Date(s + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return dateStr(d);
}
$back.addEventListener('click', () => openDay(shiftDate(state.dayDate, -1)));
$next.addEventListener('click', () => openDay(shiftDate(state.dayDate, 1)));
// 日別記録画面で日付タイトルをタップすると、その月のカレンダーへ戻る
// （openDay が表示月を同期済みのため、タブを切り替えるだけでよい）
$title.addEventListener('click', () => {
  if (state.tab === 'day') { state.tab = 'calendar'; render(); }
});

// ---------- カレンダー ----------

async function renderCalendar() {
  setHeader('PUMP', false);

  // バックアップ喚起: データはブラウザ内にしかないため、書き出しが古いと警告する
  let banner = '';
  if (state.sessions.length > 0) {
    const lastExport = await getSetting('lastExportAt', null);
    if (!lastExport) {
      banner = 'バックアップ未実施です。設定画面から書き出してください';
    } else {
      const days = Math.floor((Date.now() - lastExport) / 86400000);
      if (days >= 14) banner = `最終バックアップから${days}日経過。書き出しをおすすめします`;
    }
  }

  const y = state.calYear, m = state.calMonth;
  const first = new Date(y, m, 1);
  const startOffset = (first.getDay() + 6) % 7; // 月曜始まり
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = todayStr();

  let cells = '';
  for (let i = 0; i < startOffset; i++) cells += '<div class="cal-cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
    const has = !!getSession(ds);
    const isToday = ds === today;
    cells += `<div class="cal-cell${isToday ? ' today' : ''}${has ? ' has-record' : ''}" data-date="${ds}">
      <span class="cal-day">${d}</span>${has ? '<span class="cal-dot"></span>' : ''}
    </div>`;
  }

  // 部位別の経過時間（最終トレーニングから何日と何時間前か）
  const partRows = PARTS.map(part => {
    let lastTs = null;
    for (let i = state.sessions.length - 1; i >= 0 && !lastTs; i--) {
      const s = state.sessions[i];
      if (s.entries.some(e => exPart(e.exId) === part)) {
        // 実施時刻の記録がない古いデータはその日の 0:00 とみなす
        lastTs = s.updatedAt || new Date(s.date + 'T00:00:00').getTime();
      }
    }
    if (!lastTs) return '';
    const mins = Math.max(0, Math.floor((Date.now() - lastTs) / 60000));
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    let label;
    if (mins < 60) label = 'さっき';
    else if (days === 0) label = `${hours}時間前`;
    else if (hours === 0) label = `${days}日前`;
    else label = `${days}日${hours}時間前`;
    const cls = days >= 7 ? 'stale' : days >= 4 ? 'warn' : 'fresh';
    return `<div class="part-row" data-part="${part}"><span class="part-name">${part}</span>
      <span class="part-days ${cls}">${label}</span><span class="part-arrow">&#8250;</span></div>`;
  }).join('');

  $view.innerHTML = `
    ${banner ? `<button class="backup-banner" id="backup-banner">${banner}</button>` : ''}
    <div class="cal-nav">
      <button class="icon-btn" id="cal-prev">&#8249;</button>
      <button class="cal-title" id="cal-title">${y}年${m + 1}月<span class="cal-caret">&#9662;</span></button>
      <button class="icon-btn" id="cal-next">&#8250;</button>
    </div>
    <div class="cal-grid">
      ${WEEKDAYS.map(w => `<div class="cal-head">${w}</div>`).join('')}
      ${cells}
    </div>
    <button class="primary-btn" id="today-btn">今日の記録をつける</button>
    ${partRows ? `<section class="card"><h2>部位別 最終トレーニング</h2>${partRows}</section>` : ''}
  `;

  document.getElementById('cal-prev').onclick = () => {
    state.calMonth--; if (state.calMonth < 0) { state.calMonth = 11; state.calYear--; } render();
  };
  document.getElementById('cal-next').onclick = () => {
    state.calMonth++; if (state.calMonth > 11) { state.calMonth = 0; state.calYear++; } render();
  };
  document.getElementById('today-btn').onclick = () => openDay(today);
  document.getElementById('cal-title').onclick = openMonthPicker;
  const $banner = document.getElementById('backup-banner');
  if ($banner) $banner.onclick = () => { state.tab = 'settings'; render(); };
  $view.querySelectorAll('.cal-cell[data-date]').forEach(c => {
    c.addEventListener('click', () => openDay(c.dataset.date));
  });
  // 部位行タップでその部位のグラフへ
  $view.querySelectorAll('.part-row[data-part]').forEach(r => {
    r.addEventListener('click', () => {
      state.graphPart = r.dataset.part;
      state.tab = 'graph';
      render();
    });
  });
}

// 年月ピッカー: 年は左右矢印、月は12ボタンから選ぶ
function openMonthPicker() {
  let year = state.calYear;
  const modal = openModal(`
    <h2>年月を選択</h2>
    <div class="ym-year">
      <button class="icon-btn" id="ym-prev">&#8249;</button>
      <span id="ym-year">${year}年</span>
      <button class="icon-btn" id="ym-next">&#8250;</button>
    </div>
    <div class="ym-grid">
      ${Array.from({ length: 12 }, (_, i) =>
        `<button class="ym-month" data-m="${i}">${i + 1}月</button>`).join('')}
    </div>
  `);
  const highlight = () => {
    modal.querySelectorAll('.ym-month').forEach(b => {
      b.classList.toggle('current', year === state.calYear && Number(b.dataset.m) === state.calMonth);
    });
  };
  const setYear = d => {
    year += d;
    modal.querySelector('#ym-year').textContent = `${year}年`;
    highlight();
  };
  highlight();
  modal.querySelector('#ym-prev').onclick = () => setYear(-1);
  modal.querySelector('#ym-next').onclick = () => setYear(1);
  modal.querySelectorAll('.ym-month').forEach(b => b.onclick = () => {
    state.calYear = year;
    state.calMonth = Number(b.dataset.m);
    closeModal();
    render();
  });
}

function openDay(date) {
  state.dayDate = date;
  // 前日/翌日ナビで月をまたいでもカレンダーに戻ったとき同じ月が出るよう同期する
  state.calYear = Number(date.slice(0, 4));
  state.calMonth = Number(date.slice(5, 7)) - 1;
  state.tab = 'day';
  render();
}

// ---------- 日別記録 ----------

function renderDay() {
  const date = state.dayDate;
  setHeader(`${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日(${jpWeekday(date)})`, true);
  const session = getSession(date) || { date, entries: [] };

  const entriesHtml = session.entries.map((en, ei) => {
    const prev = prevEntry(en.exId, date);
    const bw = exIsBw(en.exId);
    const best = bestBefore(en.exId, date, bw);
    const isPb = s => { const v = bw ? s.r : s.w; return best !== null && v > best && v > 0; };
    const setsHtml = en.sets.map((s, si) => `
      <div class="set-row${s.done ? ' done' : ''}${bw ? ' bw' : ''}" data-ei="${ei}" data-si="${si}">
        <span class="set-no${isPb(s) ? ' pb' : ''}">${isPb(s) ? '&#9733;' : si + 1}</span>
        ${bw ? '<span class="unit bw-unit">自重+</span>' : ''}
        <input type="number" inputmode="decimal" step="0.5" min="0" class="w-input" value="${s.w}" aria-label="${bw ? '追加重量' : '重量'}">
        <span class="unit">kg</span>
        <input type="number" inputmode="numeric" step="1" min="0" class="r-input" value="${s.r}" aria-label="回数">
        <span class="unit">回</span>
        <button class="done-btn">${s.done ? '済' : '完了'}</button>
        <button class="del-set-btn" aria-label="セット削除">&times;</button>
      </div>`).join('');
    return `
      <section class="card entry" data-ei="${ei}">
        <div class="entry-head">
          <span class="part-chip">${exPart(en.exId)}</span>
          <span class="entry-name">${esc(exName(en.exId))}${bw ? '<span class="bw-tag">自重</span>' : ''}</span>
          <button class="del-entry-btn" aria-label="種目削除">&times;</button>
        </div>
        ${prev ? `<div class="prev-info">前回 ${fmtShortDate(prev.date)} : ${setsSummary(prev.entry.sets, bw)} ${diffInfoHtml(en, date)}</div>` : ''}
        ${setsHtml}
        <button class="add-set-btn" data-ei="${ei}">セット追加</button>
      </section>`;
  }).join('');

  $view.innerHTML = `
    ${entriesHtml || '<p class="empty-msg">まだ記録がありません</p>'}
    <button class="primary-btn" id="add-ex-btn">種目を追加</button>
  `;

  document.getElementById('add-ex-btn').onclick = () => openExercisePicker(session);

  // 重量/回数の変更後、フォーカスを奪わずに差分・自己ベスト表示だけ更新する
  function refreshEntryStatus(card, en) {
    const bw = exIsBw(en.exId);
    const best = bestBefore(en.exId, date, bw);
    const diffEl = card.querySelector('.diff-info');
    if (diffEl) diffEl.outerHTML = diffInfoHtml(en, date);
    card.querySelectorAll('.set-row').forEach((row, si) => {
      const s = en.sets[si];
      if (!s) return;
      const v = bw ? s.r : s.w;
      const pb = best !== null && v > best && v > 0;
      const no = row.querySelector('.set-no');
      no.innerHTML = pb ? '&#9733;' : String(si + 1);
      no.classList.toggle('pb', pb);
    });
  }

  $view.querySelectorAll('.entry').forEach(card => {
    const ei = Number(card.dataset.ei);

    card.querySelector('.del-entry-btn').onclick = async () => {
      if (!confirm(`「${exName(session.entries[ei].exId)}」を削除しますか？`)) return;
      session.entries.splice(ei, 1);
      await saveSession(session); render();
    };

    card.querySelectorAll('.add-set-btn').forEach(b => b.onclick = async () => {
      const sets = session.entries[ei].sets;
      const last = sets[sets.length - 1];
      sets.push({ w: last ? last.w : 0, r: last ? last.r : 0, done: false });
      await saveSession(session); render();
    });

    card.querySelectorAll('.set-row').forEach(row => {
      const si = Number(row.dataset.si);
      const set = session.entries[ei].sets[si];

      row.querySelector('.w-input').addEventListener('change', async e => {
        set.w = Number(e.target.value) || 0;
        await saveSession(session);
        refreshEntryStatus(card, session.entries[ei]);
      });
      row.querySelector('.r-input').addEventListener('change', async e => {
        set.r = Number(e.target.value) || 0;
        await saveSession(session);
        refreshEntryStatus(card, session.entries[ei]);
      });
      row.querySelector('.done-btn').onclick = async () => {
        set.done = !set.done;
        await saveSession(session);
        if (set.done) startTimer();
        render();
      };
      row.querySelector('.del-set-btn').onclick = async () => {
        session.entries[ei].sets.splice(si, 1);
        if (session.entries[ei].sets.length === 0) session.entries.splice(ei, 1);
        await saveSession(session); render();
      };
    });
  });
}

// ---------- 種目ピッカー ----------

function openExercisePicker(session) {
  const groups = PARTS.map(part => {
    const list = state.exercises.filter(e => e.part === part);
    if (list.length === 0) return '';
    const rows = list.map(ex => {
      const prev = prevEntry(ex.id, session.date);
      return `<div class="pick-row" data-id="${ex.id}">
        <div class="pick-main">
          <span class="pick-name">${esc(ex.name)}${ex.bw ? '<span class="bw-tag">自重</span>' : ''}</span>
          ${prev ? `<span class="pick-prev">前回 ${fmtShortDate(prev.date)} : ${setsSummary(prev.entry.sets, !!ex.bw)}</span>` : '<span class="pick-prev">記録なし</span>'}
        </div>
        ${prev ? `<button class="copy-btn" data-id="${ex.id}">前回コピー</button>` : ''}
      </div>`;
    }).join('');
    return `<h3 class="pick-part">${part}</h3>${rows}`;
  }).join('');

  const modal = openModal(`
    <h2>種目を追加</h2>
    <div class="pick-list">${groups || '<p class="empty-msg">種目が未登録です。下から登録してください。</p>'}</div>
    <div class="new-ex">
      <select id="new-ex-part">${PARTS.map(p => `<option>${p}</option>`).join('')}</select>
      <input type="text" id="new-ex-name" placeholder="新しい種目名">
      <button id="new-ex-add">登録</button>
    </div>
    <label class="bw-check"><input type="checkbox" id="new-ex-bw"> 自重種目（懸垂・腕立て等。重量欄は追加重量になる）</label>
  `);

  async function addEntry(exId, copyPrev) {
    if (session.entries.some(e => e.exId === exId)) { alert('この種目は追加済みです'); closeModal(); return; }
    const prev = prevEntry(exId, session.date);
    let sets;
    if (copyPrev && prev) {
      sets = prev.entry.sets.map(s => ({ w: s.w, r: s.r, done: false }));
    } else {
      const base = prev ? prev.entry.sets[0] : { w: 0, r: 10 }; // 自重種目は追加重量0が既定
      sets = [{ w: base.w, r: base.r, done: false }];
    }
    session.entries.push({ exId, sets });
    await saveSession(session);
    closeModal(); render();
  }

  modal.querySelectorAll('.copy-btn').forEach(b => b.onclick = e => {
    e.stopPropagation(); addEntry(Number(b.dataset.id), true);
  });
  modal.querySelectorAll('.pick-row').forEach(r => r.onclick = () => addEntry(Number(r.dataset.id), false));

  modal.querySelector('#new-ex-add').onclick = async () => {
    const name = modal.querySelector('#new-ex-name').value.trim();
    const part = modal.querySelector('#new-ex-part').value;
    const bw = modal.querySelector('#new-ex-bw').checked;
    if (!name) return;
    if (state.exercises.some(e => e.name === name)) { alert('同名の種目があります'); return; }
    const id = await db.add('exercises', { name, part, bw });
    await reloadData();
    await addEntry(id, false);
  };
}

// ---------- タイマー ----------

const $timerBar = document.getElementById('timer-bar');
const $timerRemain = document.getElementById('timer-remain');

// 終了時刻ベースで残りを計算する（バックグラウンドで setInterval が
// 止まっても、復帰時に正しい残り時間へ追いつける）
async function startTimer() {
  const sec = await getSetting('timerSec', 90);
  state.timerEndAt = Date.now() + sec * 1000;
  $timerBar.classList.remove('hidden');
  unlockAudio(); // iOS はユーザー操作起点でしか音声を有効化できないため、開始時に解錠しておく
  requestWakeLock();
  clearInterval(state.timerId);
  state.timerId = setInterval(tickTimer, 500);
  tickTimer();
}

function tickTimer() {
  state.timerRemain = Math.max(0, Math.ceil((state.timerEndAt - Date.now()) / 1000));
  updateTimerLabel();
  if (state.timerRemain <= 0) {
    stopTimer();
    playAlarm();
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.timerId) tickTimer();
});

// タイマー作動中は画面をスリープさせない（ロックすると JS が止まり
// 終了に気づけないため）。非対応環境では黙って何もしない
let wakeLock = null;
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 非対応 */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// アラーム音: タイマー開始（ユーザー操作）時に AudioContext を解錠しておき、
// 満了時に約1.6秒のパルス音を鳴らして自動停止する
let audioCtx = null;
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* 音が出せない環境では無視 */ }
}

function playAlarm() {
  try {
    if (!audioCtx) return;
    // ドミソド（C5-E5-G5-C6）の上昇アルペジオを2回鳴らす。正弦波 +
    // ゆるやかな減衰でベル風のやわらかい音。全体で約2.5秒、自動停止
    const t0 = audioCtx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    [0, 1.2].forEach(offset => {
      notes.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        const start = t0 + offset + i * 0.16;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.22, start + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);
        osc.start(start);
        osc.stop(start + 0.95);
      });
    });
  } catch (e) { /* 音が出せない環境では無視 */ }
}

function updateTimerLabel() {
  const m = Math.floor(state.timerRemain / 60), s = state.timerRemain % 60;
  $timerRemain.textContent = `${m}:${pad(s)}`;
}

function stopTimer() {
  clearInterval(state.timerId);
  state.timerId = null;
  $timerBar.classList.add('hidden');
  releaseWakeLock();
}

document.getElementById('timer-stop').onclick = stopTimer;

// ---------- グラフ ----------

// 日付の短縮表記: MM-DD（曜）
function fmtShortDate(s) {
  return `${s.slice(5, 7)}-${s.slice(8, 10)}（${jpWeekday(s)}）`;
}

function renderGraph() {
  setHeader('推移グラフ', false);
  const usedIds = new Set(state.sessions.flatMap(s => s.entries.map(e => e.exId)));
  const parts = PARTS.filter(p => state.exercises.some(e => e.part === p && usedIds.has(e.id)));

  if (parts.length === 0) {
    $view.innerHTML = '<p class="empty-msg">記録が増えるとここに推移グラフが表示されます</p>';
    return;
  }
  // 既定は ALL（全部位の種目を部位順に表示）
  if (state.graphPart !== 'ALL' && !parts.includes(state.graphPart)) state.graphPart = 'ALL';

  const all = state.graphPart === 'ALL';
  const exList = state.exercises
    .filter(e => usedIds.has(e.id) && (all || e.part === state.graphPart))
    .sort((a, b) => PARTS.indexOf(a.part) - PARTS.indexOf(b.part));
  const options = ['ALL', ...parts].map(p =>
    `<option value="${p}"${p === state.graphPart ? ' selected' : ''}>${p}</option>`).join('');

  // 部位内の種目ごとにグラフ + 自己ベスト + 直近履歴のカードを並べる
  const cards = exList.map(ex => {
    const rows = [];
    for (let i = state.sessions.length - 1; i >= 0 && rows.length < 5; i--) {
      const en = state.sessions[i].entries.find(e => e.exId === ex.id);
      if (en) rows.push(`<div class="hist-row"><span>${fmtShortDate(state.sessions[i].date)}</span><span>${setsSummary(en.sets, !!ex.bw)}</span></div>`);
    }
    const pts = seriesFor(ex.id);
    const best = pts.length ? Math.max(...pts.map(p => p.max)) : null;
    return `
      <section class="card">
        <h2>${all ? `【${ex.part}】` : ''}${esc(ex.name)} — ${ex.bw ? '合計回数の推移' : '最大重量の推移'}</h2>
        ${best !== null ? `<p class="pb-line">自己ベスト: ${best}${ex.bw ? '回' : 'kg'}</p>` : ''}
        <canvas class="graph-canvas" data-ex="${ex.id}" width="640" height="400"></canvas>
        ${rows.join('')}
      </section>`;
  }).join('');

  $view.innerHTML = `
    <select id="graph-part" class="graph-select">${options}</select>
    ${cards}
  `;
  document.getElementById('graph-part').onchange = e => {
    state.graphPart = e.target.value; render();
  };
  $view.querySelectorAll('.graph-canvas').forEach(cv => drawGraph(Number(cv.dataset.ex), cv));
}

// グラフ系列: 自重種目 = セッション合計回数 / 通常種目 = セッション最大重量
function seriesFor(exId) {
  const bw = exIsBw(exId);
  const points = [];
  for (const s of state.sessions) {
    const en = s.entries.find(e => e.exId === exId);
    if (en && en.sets.length) {
      const max = bw ? en.sets.reduce((sum, x) => sum + x.r, 0) : Math.max(...en.sets.map(x => x.w));
      points.push({ date: s.date, max });
    }
  }
  return points;
}

function drawGraph(exId, cv) {
  const data = seriesFor(exId).slice(-30);
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, PAD = 48;
  const fg = getComputedStyle(document.body).getPropertyValue('--fg').trim() || '#ddd';
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#4a9eff';
  ctx.clearRect(0, 0, W, H);
  if (data.length === 0) return;

  const ys = data.map(p => p.max);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (yMin === yMax) { yMin -= 5; yMax += 5; }
  const pad = (yMax - yMin) * 0.15;
  yMin -= pad; yMax += pad;

  const px = i => data.length === 1 ? W / 2 : PAD + (W - PAD * 1.5) * i / (data.length - 1);
  const py = v => H - PAD + (PAD * 1.5 - H) * (v - yMin) / (yMax - yMin);

  // グリッド（極薄のヘアライン）と y 軸ラベル
  ctx.font = '19px -apple-system, sans-serif';
  for (let g = 0; g <= 4; g++) {
    const v = yMin + (yMax - yMin) * g / 4;
    const y = py(v);
    ctx.strokeStyle = fg; ctx.globalAlpha = 0.08; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD / 2, y); ctx.stroke();
    ctx.globalAlpha = 0.45; ctx.fillStyle = fg;
    ctx.fillText(Math.round(v * 10) / 10, 4, y + 6);
  }
  ctx.globalAlpha = 1;

  // 折れ線の下に淡いグラデーション面を敷く
  if (data.length > 1) {
    const grad = ctx.createLinearGradient(0, py(yMax), 0, py(yMin));
    grad.addColorStop(0, accent + '2e');
    grad.addColorStop(1, accent + '00');
    ctx.fillStyle = grad;
    ctx.beginPath();
    data.forEach((p, i) => { i === 0 ? ctx.moveTo(px(i), py(p.max)) : ctx.lineTo(px(i), py(p.max)); });
    ctx.lineTo(px(data.length - 1), py(yMin));
    ctx.lineTo(px(0), py(yMin));
    ctx.closePath();
    ctx.fill();
  }

  // 折れ線（丸端・丸継ぎ）
  ctx.strokeStyle = accent; ctx.lineWidth = 4;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  data.forEach((p, i) => { i === 0 ? ctx.moveTo(px(i), py(p.max)) : ctx.lineTo(px(i), py(p.max)); });
  ctx.stroke();
  ctx.fillStyle = accent;
  data.forEach((p, i) => {
    ctx.beginPath(); ctx.arc(px(i), py(p.max), 5.5, 0, Math.PI * 2); ctx.fill();
  });

  // x 軸ラベル（最初・中間・最後）
  ctx.fillStyle = fg; ctx.globalAlpha = 0.45;
  const labelIdx = [...new Set([0, Math.floor((data.length - 1) / 2), data.length - 1])];
  labelIdx.forEach(i => {
    const t = data[i].date.slice(5).replace('-', '/');
    ctx.fillText(t, Math.min(px(i) - 20, W - 60), H - 8);
  });
  ctx.globalAlpha = 1;
}

// ---------- 設定 ----------

async function renderSettings() {
  setHeader('設定', false);
  const timerSec = await getSetting('timerSec', 90);
  const bodyWeight = await getSetting('bodyWeight', '');

  const exRows = state.exercises.map(ex => `
    <div class="ex-manage-row" data-id="${ex.id}">
      <span class="part-chip">${ex.part}</span>
      <span class="ex-manage-name">${esc(ex.name)}</span>
      <button class="ex-del-btn" aria-label="削除">&times;</button>
    </div>`).join('');

  $view.innerHTML = `
    <section class="card">
      <h2>セット間タイマー</h2>
      <div class="setting-row">
        <label for="timer-sec">休憩時間（秒）</label>
        <input type="number" id="timer-sec" inputmode="numeric" min="10" max="600" step="10" value="${timerSec}">
      </div>
    </section>
    <section class="card">
      <h2>体重</h2>
      <p class="note">自重種目の実効負荷の参考値。記録の必須項目ではありません。</p>
      <div class="setting-row">
        <label for="body-weight">体重（kg）</label>
        <input type="number" id="body-weight" inputmode="decimal" min="0" max="300" step="0.1" value="${bodyWeight}" placeholder="未設定">
      </div>
    </section>
    <section class="card">
      <h2>種目の管理</h2>
      ${exRows || '<p class="note">種目が未登録です</p>'}
    </section>
    <section class="card">
      <h2>データ概要</h2>
      <p class="note">記録日数: ${state.sessions.length}日 / 種目数: ${state.exercises.length}</p>
    </section>
    <section class="card">
      <h2>エクスポート</h2>
      <p class="note">記録データはこの端末のブラウザ内に保存されています。定期的に書き出して iCloud 等に保存してください。</p>
      <div class="btn-row">
        <button id="export-json">JSON 書き出し</button>
        <button id="export-md">markdown 書き出し</button>
      </div>
    </section>
    <section class="card">
      <h2>インポート</h2>
      <p class="note">JSON 書き出しファイルから復元します（現在のデータは上書きされます）。</p>
      <input type="file" id="import-file" accept=".json,application/json">
    </section>
  `;

  document.getElementById('timer-sec').addEventListener('change', async e => {
    const v = Math.max(10, Math.min(600, Number(e.target.value) || 90));
    await setSetting('timerSec', v);
  });

  document.getElementById('body-weight').addEventListener('change', async e => {
    const v = Number(e.target.value);
    await setSetting('bodyWeight', v > 0 ? v : '');
  });

  document.getElementById('export-json').onclick = exportJson;
  document.getElementById('export-md').onclick = exportMarkdown;
  document.getElementById('import-file').addEventListener('change', importJson);

  $view.querySelectorAll('.ex-del-btn').forEach(b => b.onclick = async () => {
    const id = Number(b.closest('.ex-manage-row').dataset.id);
    const used = state.sessions.some(s => s.entries.some(e => e.exId === id));
    if (used) { alert('記録で使用中の種目は削除できません'); return; }
    if (!confirm(`「${exName(id)}」を削除しますか？`)) return;
    await db.del('exercises', id);
    await reloadData(); render();
  });
}

// ---------- エクスポート / インポート ----------

// 書き出しに成功したら true（キャンセル時は false）
async function shareOrDownload(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const file = new File([blob], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false; // ユーザーキャンセル
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  return true;
}

async function markExported() {
  await setSetting('lastExportAt', Date.now());
}

async function exportJson() {
  const payload = {
    app: 'kintore-app',
    version: 1,
    exportedAt: new Date().toISOString(),
    bodyWeight: await getSetting('bodyWeight', ''),
    exercises: state.exercises,
    sessions: state.sessions,
  };
  const ok = await shareOrDownload(`kintore_${todayStr()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  if (ok) { await markExported(); render(); }
}

async function exportMarkdown() {
  const lines = [`# 筋トレ記録エクスポート（${todayStr()} 時点）`, ''];
  for (let i = state.sessions.length - 1; i >= 0; i--) {
    const s = state.sessions[i];
    lines.push(`## ${s.date} (${jpWeekday(s.date)})`, '');
    for (const en of s.entries) {
      lines.push(`- ${exName(en.exId)} [${exPart(en.exId)}]: ${setsSummary(en.sets, exIsBw(en.exId))}`);
    }
    lines.push('');
  }
  const ok = await shareOrDownload(`kintore_${todayStr()}.md`, lines.join('\n'), 'text/markdown');
  if (ok) { await markExported(); render(); }
}

async function importJson(e) {
  const f = e.target.files[0];
  if (!f) return;
  let payload;
  try {
    payload = JSON.parse(await f.text());
    if (payload.app !== 'kintore-app' || !Array.isArray(payload.sessions)) throw new Error('形式不正');
  } catch (err) {
    alert('読み込めませんでした。kintore-app の JSON 書き出しファイルを指定してください。');
    return;
  }
  if (!confirm(`${payload.sessions.length}日分の記録を取り込み、現在のデータを置き換えます。よろしいですか？`)) return;
  await db.clear('exercises');
  await db.clear('sessions');
  for (const ex of payload.exercises) await db.put('exercises', ex);
  for (const s of payload.sessions) await db.put('sessions', s);
  if (payload.bodyWeight) await setSetting('bodyWeight', payload.bodyWeight);
  await reloadData();
  alert('取り込みました');
  render();
}

// ---------- モーダル ----------

const $modalRoot = document.getElementById('modal-root');

function openModal(html) {
  $modalRoot.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal">${html}<button class="modal-close">閉じる</button></div>`;
  $modalRoot.querySelector('.modal-backdrop').onclick = closeModal;
  $modalRoot.querySelector('.modal-close').onclick = closeModal;
  return $modalRoot.querySelector('.modal');
}
function closeModal() { $modalRoot.innerHTML = ''; }

// ---------- プルリフレッシュ ----------
// 画面最上部で下に引っ張ると再読み込みする。しきい値未満で離したら何もしない。
// 再読み込み後も同じ画面に戻れるよう、表示状態を退避してから reload する

const $pull = document.getElementById('pull-indicator');
const PULL_THRESHOLD = 110;
let pullStartY = null;
let pullDy = 0;

document.addEventListener('touchstart', e => {
  // スクロール領域（#view）の最上部から開始したときのみ対象（モーダル表示中は無効）
  pullStartY = ($view.scrollTop <= 0 && !document.querySelector('.modal')) ? e.touches[0].clientY : null;
  pullDy = 0;
}, { passive: true });

document.addEventListener('touchmove', e => {
  if (pullStartY === null) return;
  pullDy = e.touches[0].clientY - pullStartY;
  if (pullDy > 15 && $view.scrollTop <= 0) {
    const shown = Math.min(pullDy / 2, 70);
    $pull.classList.remove('hidden');
    $pull.style.transform = `translateX(-50%) translateY(${shown}px)`;
    $pull.textContent = pullDy >= PULL_THRESHOLD ? '離して更新' : '引っ張って更新';
    $pull.classList.toggle('ready', pullDy >= PULL_THRESHOLD);
  }
}, { passive: true });

document.addEventListener('touchend', () => {
  if (pullStartY !== null && pullDy >= PULL_THRESHOLD) {
    $pull.textContent = '更新中...';
    sessionStorage.setItem('viewState', JSON.stringify({
      tab: state.tab,
      dayDate: state.dayDate,
      graphPart: state.graphPart,
      calYear: state.calYear,
      calMonth: state.calMonth,
    }));
    location.reload();
    return;
  }
  $pull.classList.add('hidden');
  $pull.classList.remove('ready');
  $pull.style.transform = '';
  pullStartY = null;
  pullDy = 0;
});

// ---------- 起動 ----------

(async function init() {
  await db.open();
  await reloadData();
  // 部位名変更の移行: 旧「その他」→「体力」（2026-07-04）
  const legacy = state.exercises.filter(e => e.part === 'その他');
  if (legacy.length > 0) {
    for (const ex of legacy) { ex.part = '体力'; await db.put('exercises', ex); }
    await reloadData();
  }
  const now = new Date();
  state.calYear = now.getFullYear();
  state.calMonth = now.getMonth();
  // プルリフレッシュ前の画面状態があれば復元する
  const saved = sessionStorage.getItem('viewState');
  if (saved) {
    sessionStorage.removeItem('viewState');
    try { Object.assign(state, JSON.parse(saved)); } catch (e) { /* 壊れていたら既定表示 */ }
  }
  render();
})();
