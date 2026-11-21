import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTimeScale, samplingStep, snapFps, frameCenter } from '../js/timebase.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('일반 모드는 배율 1', () => {
  const r = computeTimeScale({ mode: 'normal', fileFps: 60 });
  assert.equal(r.timeScale, 1);
  assert.equal(r.effectiveFps, 60);
});

test('슬로모션 평탄화 파일(240→30)은 영상 1초 = 실제 1/8초', () => {
  const r = computeTimeScale({ mode: 'slowmo', fileFps: 30, captureFps: 240, fileType: 'auto' });
  assert.equal(r.resolvedType, 'slowed');
  close(r.timeScale, 0.125);
  assert.equal(r.effectiveFps, 240);
});

test('슬로모션 원본 고프레임 파일은 배율 1', () => {
  const r = computeTimeScale({ mode: 'slowmo', fileFps: 240, captureFps: 240, fileType: 'auto' });
  assert.equal(r.resolvedType, 'native');
  assert.equal(r.timeScale, 1);
});

test('샘플링은 실제 시간 기준 최대 30fps', () => {
  close(samplingStep({ fileFps: 60, timeScale: 1 }), 2 / 60);
  close(samplingStep({ fileFps: 30, timeScale: 1 }), 1 / 30);
  close(samplingStep({ fileFps: 240, timeScale: 1 }), 8 / 240);
  // 240fps 촬영 → 30fps 평탄화: 영상 8프레임 = 실제 1/30초
  const step = samplingStep({ fileFps: 30, timeScale: 30 / 240 });
  close(step, 8 / 30);
  close(step * (30 / 240), 1 / 30);
});

test('fps 보정과 프레임 중앙', () => {
  assert.equal(snapFps(59.94), 60);
  assert.equal(snapFps(29.97), 30);
  assert.equal(snapFps(239.2), 240);
  assert.equal(snapFps(0), 30);
  close(frameCenter(0, 60), 0.5 / 60);
  close(frameCenter(1 / 60, 60), 1.5 / 60);
  close(frameCenter(1.5 / 60, 60), 1.5 / 60);
});
