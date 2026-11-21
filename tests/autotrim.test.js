import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoTrimWindow } from '../js/phases.js';
import { makeSamples, TRUTH } from './synth.js';

test('긴 영상(앞뒤 여유)에서 실제 10fps 성긴 샘플로 임팩트 근처를 잘라냄', () => {
  // 앞에 3초 정지 구간을 붙인 6초 영상을 실제 10fps로 샘플링
  const pad = 3;
  const s = makeSamples({ realFps: 10, duration: 3 }).map((x) => ({ ...x, t: x.t + pad }));
  const still = makeSamples({ realFps: 10, duration: 2.9 }).slice(0, 30).map((x, i) => ({ t: i / 10, lm: makeSamples({ duration: 0 })[0].lm }));
  const samples = [...still, ...s];
  const w = autoTrimWindow(samples, { aspect: 1, timeScale: 1, duration: 6 });
  assert.ok(w, '창을 찾아야 함');
  assert.ok(Math.abs(w.impactGuess - (TRUTH.impact + pad)) <= 0.21, `impact ${w.impactGuess}`);
  assert.ok(w.start <= TRUTH.address + pad && w.end >= TRUTH.finish + pad - 0.3, `${w.start}~${w.end}`);
});

test('슬로모션 평탄화(×1/8)에서는 영상 시간으로 8배 넓게 자름', () => {
  const samples = makeSamples({ realFps: 10, timeScale: 1 / 8 });
  const w = autoTrimWindow(samples, { aspect: 1, timeScale: 1 / 8, duration: 2.8 * 8 });
  assert.ok(w);
  assert.ok(Math.abs((w.impactGuess - w.start) - Math.min(w.impactGuess, 2.2 * 8)) < 1e-9);
});

test('사람이 거의 없으면 null', () => {
  const samples = makeSamples({ realFps: 10 }).map((x) => ({ ...x, lm: null }));
  assert.equal(autoTrimWindow(samples, { aspect: 1, timeScale: 1, duration: 3 }), null);
});
