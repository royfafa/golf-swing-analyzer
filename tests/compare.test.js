import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeAtOffset, offsetAt, syncRange, playbackPlan } from '../js/compare.js';
import { computeTimeScale } from '../js/timebase.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// A: 60fps 실시간, 임팩트 2.0초, 길이 4초
const A = { impact: 2.0, duration: 4, tb: computeTimeScale({ mode: 'normal', fileFps: 60 }) };
// B: 240fps 촬영 → 30fps 평탄화(×1/8), 임팩트 영상 10초(= 실제 1.25초), 길이 영상 24초(= 실제 3초)
const B = { impact: 10, duration: 24, tb: computeTimeScale({ mode: 'slowmo', fileFps: 30, captureFps: 240, fileType: 'auto' }) };

test('임팩트 기준 실제 시간 ↔ 영상 시간 변환', () => {
  close(timeAtOffset(A, -0.25), 1.75);
  close(timeAtOffset(B, -0.25), 8); // 실제 0.25초 = 영상 2초
  close(offsetAt(B, 8), -0.25);
  close(offsetAt(A, timeAtOffset(A, 0.4)), 0.4);
});

test('함께 보기 구간: 두 영상이 모두 있는 부분, 임팩트 전 3초·후 2초 이내', () => {
  const r = syncRange([A, B]);
  close(r.lo, -1.25); // B는 임팩트 전 실제 1.25초까지만 있음
  close(r.hi, 1.75);  // B는 임팩트 후 실제 (24-10)/8 = 1.75초
  const r2 = syncRange([A]);
  close(r2.lo, -2); close(r2.hi, 2);
});

test('재생 계획: 실제 ¼배속이면 A ×0.25, B ×2 → 동시 재생 가능', () => {
  const p = playbackPlan([A, B], 0.25);
  close(p.rates[0], 0.25); close(p.rates[1], 2);
  assert.equal(p.native, true);
});

test('재생 계획: 실제 1배속이면 B ×8 → 프레임 이동 재생으로 전환', () => {
  const p = playbackPlan([A, B], 1);
  close(p.rates[1], 8);
  assert.equal(p.native, false);
});
