import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipInfiniteLine, autoAnchors } from '../js/lines.js';
import { baseLandmarks } from './synth.js';

test('무한 직선을 화면 경계로 자르기', () => {
  const seg = clipInfiniteLine({ x: 10, y: 10 }, { x: 20, y: 20 }, 100, 50);
  assert.deepEqual(seg.map((p) => [Math.round(p.x), Math.round(p.y)]), [[0, 0], [50, 50]]);
  const v = clipInfiniteLine({ x: 30, y: 5 }, { x: 30, y: 6 }, 100, 50);
  assert.deepEqual(v.map((p) => [p.x, p.y]), [[30, 0], [30, 50]]);
  assert.equal(clipInfiniteLine({ x: 1, y: 1 }, { x: 1, y: 1 }, 10, 10), null);
});

test('자동선 기준점: 어드레스 자세의 어깨·손 중점', () => {
  const a = autoAnchors(baseLandmarks());
  assert.ok(Math.abs(a.shoulder.x - 0.5) < 1e-9 && Math.abs(a.shoulder.y - 0.3) < 1e-9);
  assert.ok(Math.abs(a.hands.y - 0.55) < 1e-9);
  assert.equal(autoAnchors(null), null);
});
