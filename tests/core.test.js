// Run: node tests/core.test.js [path/to/song.json]
// Golden tests use samples/dance-monkey.json (not in the repo; copyrighted). Synthetic tests always run.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('../core.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.log('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}

// ---- synthetic song (always available) ----
const R = '----------------';
const tiny = {
  version: 2, bpm: 120, lanes: F.LANES,
  patterns: { a: [R, 'x-x-x-x-x-x-x-x-', R, '----x-------x---', R, 'x-------x-------'] },
  bars: [{ n: 1, to: 2, rest: true, section: 'Intro' }, { n: 3, to: 4, use: 'a', section: 'Chorus' }],
  form: [{ from: 1, to: 2 }, { from: 3, to: 4, times: 3 }],
  multiRest: [{ n: 1, count: 2 }],
};

console.log('synthetic');
test('validate ok', () => assert.deepStrictEqual(F.validate(tiny), []));
test('expand repeats', () => {
  const m = F.prepare(tiny);
  assert.strictEqual(m.play.length, 2 + 2 * 3);
  assert.deepStrictEqual(m.play.map((p) => p.printedN), [1, 2, 3, 4, 3, 4, 3, 4]);
  assert.deepStrictEqual(m.play.map((p) => p.pass), [1, 1, 1, 1, 2, 2, 3, 3]);
});
test('units collapse multi-rest', () => {
  const m = F.prepare(tiny);
  assert.deepStrictEqual(m.units.map((u) => u.type + u.n), ['multi1', 'bar3', 'bar4']);
});
test('sections merge across repeats', () => {
  const m = F.prepare(tiny);
  assert.deepStrictEqual(m.sections.map((s) => [s.name, s.start, s.end]), [['Intro', 0, 2], ['Chorus', 2, 8]]);
});
test('validation catches gaps and bad patterns', () => {
  const bad = JSON.parse(JSON.stringify(tiny));
  bad.bars[1].n = 4; bad.bars[1].use = 'zzz';
  const errs = F.validate(bad);
  assert.ok(errs.some((e) => e.includes('缺少第 3')), errs.join('|'));
  assert.ok(errs.some((e) => e.includes('zzz')), errs.join('|'));
});
test('timemap linear + calibrate round trip', () => {
  const c = F.calibrate(20, 50.5, 68, 170.5);
  const tm = F.makeTimeMap({ bpm: c.bpm, firstBeatSec: c.firstBeatSec });
  assert.ok(Math.abs(tm.beatAt(50.5) - 80) < 1e-9);
  assert.ok(Math.abs(tm.beatAt(170.5) - 272) < 1e-9);
  assert.ok(Math.abs(c.bpm - 96) < 1e-9);
});
test('timemap anchors piecewise', () => {
  const tm = F.makeTimeMap({ bpm: 100, anchors: [{ bar: 0, sec: 1 }, { bar: 10, sec: 21 }, { bar: 20, sec: 45 }] });
  assert.ok(Math.abs(tm.timeAt(20) - 11) < 1e-9);
  assert.ok(Math.abs(tm.beatAt(33) - 60) < 1e-9);
  assert.ok(Math.abs(tm.timeAt(tm.beatAt(30)) - 30) < 1e-9);
});
test('cue state: rest, countdown, go, play', () => {
  const m = F.prepare(tiny); // first hit at beat 8
  assert.strictEqual(F.cueState(m, 1).mode, 'rest');
  assert.strictEqual(F.cueState(m, 1).barsLeft, 2);
  const cd = F.cueState(m, 5.2);
  assert.strictEqual(cd.mode, 'countdown');
  assert.strictEqual(cd.count, 3);
  assert.strictEqual(F.cueState(m, 8.1).mode, 'go');
  assert.strictEqual(F.cueState(m, 9.1).mode, 'play');
  assert.strictEqual(F.cueState(m, 32).mode, 'end');
});
test('engrave: eighths beamed per beat, quarter rests', () => {
  const e = F.engraveBar(F.prepare(tiny).printed[3].cells);
  assert.strictEqual(e.chords.length, 8);
  assert.ok(e.chords.every((c) => c.dur === 2 && c.group));
  const bb = F.engraveBar(F.prepare({ ...tiny, patterns: { a: [R, R, R, '----x-------x---', R, R] } }).printed[3].cells);
  assert.deepStrictEqual(bb.rests.map((r) => r.step + ':' + r.dur), ['0:4', '8:4']);
  assert.deepStrictEqual(bb.chords.map((c) => c.step + ':' + c.dur), ['4:4', '12:4']);
});

// ---- golden test on the real sample, if present ----
const samplePath = process.argv[2] || path.join(__dirname, '..', 'samples', 'dance-monkey.json');
if (fs.existsSync(samplePath)) {
  console.log('golden: ' + path.basename(samplePath));
  const song = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  const m = F.prepare(song);
  test('84 play bars', () => assert.strictEqual(m.play.length, 84));
  test('first sound at play bar 9 (printed 9)', () => {
    assert.strictEqual(m.events[0].playIndex, 8);
    assert.strictEqual(m.events[0].printedN, 9);
  });
  test('length 212.2 s at 95 bpm', () => assert.strictEqual(((m.totalBeats * 60) / 95).toFixed(1), '212.2'));
  test('cues at play index 20, 44, 68', () => assert.deepStrictEqual(m.cues.map((c) => c.playIndex), [20, 44, 68]));
  test('51 layout units (multi-rests 1-8, 11-12, 59-60 collapsed) like the PDF', () => assert.strictEqual(m.units.length, 51));
  test('bar 31 is a whole note', () => assert.ok(F.engraveBar(m.printed[31].cells).whole));
} else {
  console.log('(golden test skipped: samples/dance-monkey.json not found)');
}
console.log(`${passed} passed`);
