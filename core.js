/* follow-drum-tab core: pure logic, no DOM.
 * Works in the browser (window.FDT) and in Node (module.exports) for tests.
 * Layers: validate -> prepare (printed bars, units, play order, events, sections) -> TimeMap -> cue state.
 */
(function (root) {
  'use strict';

  // Canonical lane order (top of staff to bottom).
  const LANES = ['CY', 'HH', 'T1', 'SN', 'FT', 'BD'];
  const LANE_INFO = {
    CY: { name: '銅鈸', color: '#f5c542', pos: 10, x: true },
    HH: { name: '踩鑔', color: '#4cd3e0', pos: 9, x: true },
    T1: { name: '高嗵', color: '#6bd66b', pos: 7 },
    SN: { name: '小鼓', color: '#ff5d5d', pos: 5 },
    FT: { name: '低嗵', color: '#b583ff', pos: 3 },
    BD: { name: '底鼓', color: '#ff9a3c', pos: 1 },
  };
  const STEPS = 16;
  const REST_GAP = 3.5; // beats of silence that count as "rest"

  const isInt = (v) => Number.isInteger(v);

  function parseRow(s, steps) {
    s = String(s == null ? '' : s);
    const out = new Array(steps);
    for (let i = 0; i < steps; i++) {
      const c = s[i];
      out[i] = c && c !== '-' && c !== '.' && c !== ' ' ? 1 : 0;
    }
    return out;
  }

  // Convert 6 strings (in song.lanes order) to cells[canonicalLane][step].
  function toCells(rows, songLanes, steps) {
    const cells = LANES.map(() => new Array(steps).fill(0));
    (songLanes || LANES).forEach((lane, i) => {
      const li = LANES.indexOf(lane);
      if (li >= 0) cells[li] = parseRow(rows[i], steps);
    });
    return cells;
  }

  const emptyCells = (steps) => LANES.map(() => new Array(steps).fill(0));
  const okRows = (rows, len) => Array.isArray(rows) && rows.length === 6 && rows.every((r) => typeof r === 'string' && r.length === len);

  /* ---------- validation (messages in Traditional Chinese for the parent) ---------- */
  function validate(song) {
    const errs = [];
    if (!song || typeof song !== 'object') return ['不是有效的譜資料（需要 JSON 物件）。'];
    if (!(typeof song.bpm === 'number' && song.bpm >= 30 && song.bpm <= 300)) errs.push('bpm 需要是 30–300 之間的數字。');
    if (song.timeSig && song.timeSig !== '4/4') errs.push(`目前只支援 4/4 拍（這首是 ${song.timeSig}）。`);
    if (song.grid && song.grid !== 16) errs.push(`目前只支援 16 格（十六分音符）網格（這首是 ${song.grid}）。`);
    const lanes = song.lanes || LANES;
    if (!Array.isArray(lanes) || lanes.length !== 6 || lanes.some((l) => !LANES.includes(l))) errs.push('lanes 需要是 6 個鼓的代號：CY HH T1 SN FT BD。');

    const pats = song.patterns || {};
    for (const [name, rows] of Object.entries(pats)) {
      const len = Array.isArray(rows) && typeof rows[0] === 'string' ? rows[0].length : 0;
      if (![8, 12, 16].includes(len) || !okRows(rows, len)) {
        errs.push(`節奏型「${name}」需要 6 行、每行 16 個字元（2 拍小節 8 個、3 拍小節 12 個）。`);
      }
    }

    if (!Array.isArray(song.bars) || !song.bars.length) {
      errs.push('缺少 bars（小節）。');
      return errs;
    }
    const bars = song.bars.slice().sort((a, b) => (a.n || 0) - (b.n || 0));
    let expect = 1;
    for (const b of bars) {
      const to = b.to == null ? b.n : b.to;
      if (!isInt(b.n) || !isInt(to) || to < b.n) {
        errs.push(`小節範圍有誤：n=${b.n} to=${b.to}`);
        continue;
      }
      if (b.n !== expect) errs.push(b.n > expect ? `缺少第 ${expect}–${b.n - 1} 小節。` : `第 ${b.n} 小節重複定義。`);
      expect = to + 1;
      const beats = b.beats == null ? 4 : b.beats;
      if (![2, 3, 4].includes(beats)) errs.push(`第 ${b.n} 小節的 beats 只能是 2、3 或 4。`);
      if (!b.rest) {
        if (b.use != null) {
          if (!pats[b.use]) errs.push(`第 ${b.n} 小節用了不存在的節奏型「${b.use}」。`);
          else if (pats[b.use][0] && pats[b.use][0].length !== beats * 4) errs.push(`第 ${b.n} 小節是 ${beats} 拍，但節奏型「${b.use}」的長度不是 ${beats * 4} 格。`);
        } else if (Array.isArray(b.p)) {
          if (!okRows(b.p, beats * 4)) errs.push(`第 ${b.n} 小節的 p 需要 6 行、每行 ${beats * 4} 個字元（${beats} 拍）。`);
        } else {
          errs.push(`第 ${b.n} 小節沒有音符內容（use 或 p），也沒有標成休止。`);
        }
      }
    }
    const maxN = expect - 1;

    if (!Array.isArray(song.form) || !song.form.length) {
      errs.push('缺少 form（演奏順序）。');
    } else {
      song.form.forEach((f, i) => {
        if (!isInt(f.from) || !isInt(f.to) || f.from < 1 || f.to > maxN || f.from > f.to) errs.push(`form 第 ${i + 1} 段範圍有誤（${f.from}–${f.to}，譜只有 1–${maxN}）。`);
        if (f.times != null && !(isInt(f.times) && f.times >= 1)) errs.push(`form 第 ${i + 1} 段的 times 需要是正整數。`);
      });
    }

    if (song.rowBreaks != null && (!Array.isArray(song.rowBreaks) || song.rowBreaks.some((n) => !isInt(n) || n < 1 || n > maxN))) errs.push(`rowBreaks 需要是譜上的小節號（1–${maxN}）。`);
    for (const m of song.multiRest || []) {
      if (!isInt(m.n) || !isInt(m.count) || m.count < 2) errs.push(`multiRest 有誤：n=${m.n} count=${m.count}`);
    }
    return errs;
  }

  /* ---------- prepare: everything derived from the JSON ---------- */
  function prepare(song) {
    const errs = validate(song);
    if (errs.length) {
      const e = new Error(errs.join('\n'));
      e.errors = errs;
      throw e;
    }
    const lanes = song.lanes || LANES;
    const bars = song.bars.slice().sort((a, b) => a.n - b.n);
    const maxN = bars.reduce((m, b) => Math.max(m, b.to == null ? b.n : b.to), 0);

    // Printed bars, keyed by printed bar number.
    const printed = new Array(maxN + 1);
    let section = null;
    for (const b of bars) {
      const to = b.to == null ? b.n : b.to;
      const beats = b.beats || 4;
      const cells = b.rest ? emptyCells(beats * 4) : toCells(b.use != null ? song.patterns[b.use] : b.p, lanes, beats * 4);
      for (let n = b.n; n <= to; n++) {
        const sectionStart = n === b.n && !!b.section;
        if (sectionStart) section = b.section;
        printed[n] = { n, beats, rest: !!b.rest, cells, section, sectionStart };
      }
    }

    // Layout units: a multi-bar rest occupies one slot, like on paper.
    const multi = new Map((song.multiRest || []).map((m) => [m.n, m.count]));
    const units = [];
    for (let n = 1; n <= maxN; ) {
      const c = multi.get(n);
      if (c && c > 1) {
        units.push({ type: 'multi', n, count: c, last: n + c - 1 });
        n += c;
      } else {
        units.push({ type: 'bar', n, count: 1, last: n });
        n += 1;
      }
    }

    // Rows like on paper: explicit rowBreaks (printed bar numbers that start a row), else 4 slots per row.
    const rows = [];
    const breaks = new Set(song.rowBreaks || []);
    for (const u of units) {
      const startNew = !rows.length || (breaks.size ? [...Array(u.count).keys()].some((k) => breaks.has(u.n + k)) : rows[rows.length - 1].length >= 4);
      if (startNew) rows.push([]);
      rows[rows.length - 1].push(u);
    }

    // Repeat brackets (from form entries played more than once).
    const repeats = song.form
      .filter((f) => (f.times || 1) > 1)
      .map((f) => ({ from: f.from, to: f.to, times: f.times, assumed: !!f.assumed }));

    // Play order.
    const play = [];
    let startBeat = 0;
    song.form.forEach((f, fi) => {
      const times = f.times || 1;
      for (let pass = 1; pass <= times; pass++) {
        for (let n = f.from; n <= f.to; n++) {
          const pb = printed[n];
          play.push({ playIndex: play.length, printedN: n, pass, totalPasses: times, formIndex: fi, startBeat, beats: pb.beats, rest: pb.rest, cells: pb.cells, section: pb.section });
          startBeat += pb.beats;
        }
      }
    });

    // Hit events in play order.
    const events = [];
    for (const pb of play) {
      for (let s = 0; s < pb.beats * 4; s++) {
        const hit = [];
        for (let li = 0; li < LANES.length; li++) if (pb.cells[li][s]) hit.push(LANES[li]);
        if (hit.length) events.push({ beat: pb.startBeat + s / 4, lanes: hit, playIndex: pb.playIndex, printedN: pb.printedN, step: s });
      }
    }
    // Mark entries after a rest (for "打！").
    for (let i = 0; i < events.length; i++) {
      const gap = i === 0 ? Infinity : events[i].beat - events[i - 1].beat;
      events[i].afterRest = gap >= REST_GAP;
    }

    // Sections in play order (consecutive bars with the same label merge, so repeats stay one block).
    const sections = [];
    for (const pb of play) {
      const name = pb.section || '';
      const last = sections[sections.length - 1];
      if (last && last.name === name && last.end === pb.playIndex) last.end++;
      else sections.push({ name, start: pb.playIndex, end: pb.playIndex + 1, chorus: /(^|\s)chorus|副歌/i.test(name) });
    }
    for (const s of sections) {
      s.startBeat = play[s.start].startBeat;
      s.endBeat = play[s.end - 1].startBeat + play[s.end - 1].beats;
    }

    const model = { song, maxN, printed, units, rows, repeats, play, events, sections, totalBeats: startBeat };
    model.cues = (song.cues || []).map((c) => {
      const playIndex = cueIndex(model, c.bar, c.pass || 1);
      return { ...c, playIndex, beat: playIndex >= 0 ? play[playIndex].startBeat : null };
    });
    return model;
  }

  function cueIndex(model, bar, pass) {
    const pb = model.play.find((p) => p.printedN === bar && p.pass === pass);
    return pb ? pb.playIndex : -1;
  }

  // Play bar containing a beat (clamped to the song).
  function playAt(model, beat) {
    const p = model.play;
    let lo = 0, hi = p.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (p[m].startBeat <= beat + 1e-9) lo = m;
      else hi = m - 1;
    }
    return p[lo];
  }
  // Start beat of a play bar index (bars past the end continue at 4 beats).
  function barStartBeat(model, i) {
    if (!model) return i * 4;
    const p = model.play;
    if (i < 0) return i * 4;
    if (i < p.length) return p[i].startBeat;
    return model.totalBeats + (i - p.length) * 4;
  }

  /* ---------- TimeMap: seconds <-> beats ---------- */
  function makeTimeMap(song, model) {
    const anchors = (song.anchors || [])
      .filter((a) => Number.isFinite(a.bar) && Number.isFinite(a.sec))
      .map((a) => ({ b: barStartBeat(model, a.bar), t: a.sec }))
      .sort((x, y) => x.b - y.b);
    if (anchors.length >= 2) {
      // Piecewise linear, extrapolate with the end segments.
      const seg = (arr, key, v) => {
        let i = 0;
        while (i < arr.length - 2 && v > arr[i + 1][key]) i++;
        return [arr[i], arr[i + 1]];
      };
      return {
        kind: 'anchors',
        beatAt(t) {
          const [p, q] = seg(anchors, 't', t);
          return p.b + ((t - p.t) * (q.b - p.b)) / (q.t - p.t);
        },
        timeAt(b) {
          const [p, q] = seg(anchors, 'b', b);
          return p.t + ((b - p.b) * (q.t - p.t)) / (q.b - p.b);
        },
        get bpm() {
          const a = anchors[0], z = anchors[anchors.length - 1];
          return (60 * (z.b - a.b)) / (z.t - a.t);
        },
      };
    }
    const bpm = song.bpm;
    let f0 = Number.isFinite(song.firstBeatSec) ? song.firstBeatSec : 0;
    if (anchors.length === 1) f0 = anchors[0].t - (anchors[0].b * 60) / bpm;
    return {
      kind: 'linear',
      bpm,
      firstBeatSec: f0,
      beatAt: (t) => ((t - f0) * bpm) / 60,
      timeAt: (b) => f0 + (b * 60) / bpm,
    };
  }

  // Two-point calibration: (beat, sec) pairs -> {bpm, firstBeatSec}.
  function calibrate(b1, t1, b2, t2) {
    const beatSec = (t2 - t1) / (b2 - b1);
    return { bpm: 60 / beatSec, firstBeatSec: t1 - b1 * beatSec };
  }

  /* ---------- what the child should see right now ---------- */
  function lowerBound(events, beat) {
    let lo = 0, hi = events.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (events[m].beat < beat) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  function cueState(model, beat) {
    const ev = model.events;
    const next = lowerBound(ev, beat + 1e-6); // first event strictly after now
    const prev = next - 1;
    const playIndex = playAt(model, beat).playIndex;
    const out = { beat, playIndex, flash: [], next: null, mode: 'play' };
    if (prev >= 0 && beat - ev[prev].beat < 0.3) out.flash = ev[prev].lanes;
    if (beat >= model.totalBeats) return { ...out, mode: 'end' };
    if (next >= ev.length) return { ...out, mode: 'rest', barsLeft: 0, entry: null };
    const e = ev[next];
    out.next = e;
    const sincePrev = prev >= 0 ? beat - ev[prev].beat : Infinity;
    if (e.afterRest && sincePrev > 0.5) {
      const until = e.beat - beat;
      if (until <= 4) return { ...out, mode: 'countdown', count: Math.max(1, Math.ceil(until - 1e-9)) };
      return { ...out, mode: 'rest', barsLeft: e.playIndex - (beat < 0 ? -1 : playIndex), entry: e };
    }
    if (prev >= 0 && ev[prev].afterRest && sincePrev <= 0.5) return { ...out, mode: 'go' };
    return out;
  }

  /* ---------- engraving: turn one bar's cells into notes/rests to draw ---------- */
  function engraveBar(cells) {
    const steps = cells[0].length, beats = steps / 4;
    const onsets = [];
    for (let s = 0; s < steps; s++) {
      const lanes = [];
      for (let li = 0; li < LANES.length; li++) if (cells[li][s]) lanes.push(LANES[li]);
      if (lanes.length) onsets.push({ step: s, lanes });
    }
    if (!onsets.length) return { empty: true, chords: [], rests: [] };
    if (onsets.length === 1 && onsets[0].step === 0 && steps === 16) {
      return { whole: true, chords: [{ step: 0, lanes: onsets[0].lanes, dur: 16, group: null }], rests: [] };
    }
    const chords = [], rests = [];
    let gid = 0;
    for (let k = 0; k < beats; k++) {
      const b0 = k * 4, b1 = b0 + 4;
      const on = onsets.filter((o) => o.step >= b0 && o.step < b1);
      if (!on.length) {
        rests.push({ step: b0, dur: 4 });
        continue;
      }
      if (on[0].step > b0) rests.push({ step: b0, dur: on[0].step - b0 });
      const local = on.map((o, i) => ({ ...o, dur: (i + 1 < on.length ? on[i + 1].step : b1) - o.step }));
      const short = local.filter((o) => o.dur < 4);
      const group = short.length >= 2 ? ++gid : null;
      for (const o of local) chords.push({ step: o.step, lanes: o.lanes, dur: o.dur, group: o.dur < 4 ? group : null });
    }
    return { chords, rests };
  }

  const api = { LANES, LANE_INFO, STEPS, REST_GAP, validate, prepare, cueIndex, playAt, barStartBeat, makeTimeMap, calibrate, cueState, engraveBar, lowerBound };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FDT = api;
})(typeof window !== 'undefined' ? window : globalThis);
