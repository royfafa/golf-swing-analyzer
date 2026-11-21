import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestPhases, phasesInOrder } from '../js/phases.js';
import { makeSamples, TRUTH } from './synth.js';

function check(timeScale, realFps = 30) {
  const samples = makeSamples({ timeScale, realFps });
  const r = suggestPhases(samples, { aspect: 9 / 16, timeScale });
  assert.ok(r.times, r.warnings.join(','));
  const tol = 2 / realFps + 1e-6; // 실제 시간 ±2샘플
  for (const k of ['top', 'impact']) {
    const real = r.times[k] * timeScale;
    assert.ok(Math.abs(real - TRUTH[k]) <= tol, `${k}: ${real} vs ${TRUTH[k]}`);
  }
  // 어드레스는 "움직이기 시작하기 직전"이므로 실제 시작보다 약간 이를 수 있다
  const addr = r.times.address * timeScale;
  assert.ok(addr <= TRUTH.address + 0.15 && addr >= TRUTH.address - 0.3, `address ${addr}`);
  assert.ok(phasesInOrder(r.times));
}

test('실시간 영상에서 탑·임팩트 제안', () => check(1));
test('슬로모션 평탄화(×1/8)에서도 같은 실제 시점', () => check(1 / 8));
test('원본 고프레임 상당(샘플 30fps)', () => check(1, 30));

test('사람 인식이 거의 없으면 제안하지 않음', () => {
  const samples = makeSamples().map((s, i) => (i % 3 ? { ...s, lm: null } : s));
  const r = suggestPhases(samples, { aspect: 1, timeScale: 1 });
  assert.equal(r.times, null);
});

test('순서 검사', () => {
  assert.equal(phasesInOrder({ address: 1, top: 2, impact: 3, finish: 4 }), true);
  assert.equal(phasesInOrder({ address: 1, top: 3, impact: 2, finish: 4 }), false);
});
