import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, computeTempo, spineTilt, landmarksAt } from '../js/metrics.js';
import { makeSamples, TRUTH, baseLandmarks } from './synth.js';

test('템포 비율은 슬로모션 배율과 무관, 절대 시간만 배율 의존', () => {
  const real = computeTempo(TRUTH, 1);
  const slowTimes = Object.fromEntries(Object.entries(TRUTH).map(([k, v]) => [k, v * 8]));
  const slow = computeTempo(slowTimes, 1 / 8);
  assert.ok(Math.abs(real.ratio - slow.ratio) < 1e-9);
  assert.ok(Math.abs(real.backSec - 0.8) < 1e-9);
  assert.ok(Math.abs(slow.backSec - 0.8) < 1e-9);
  assert.ok(Math.abs(real.ratio - 0.8 / 0.27) < 1e-9);
});

test('정면: 머리 이동을 신장 대비 %로 계산하고 타깃 방향을 판별', () => {
  // 백스윙 동안 머리가 타깃 반대쪽(화면 왼쪽)으로 0.02(화면 높이 단위 아님, x 정규화) 이동
  const aspect = 1;
  const samples = makeSamples({
    mutate: (lm, tr) => {
      const u = Math.min(1, Math.max(0, (tr - TRUTH.address) / (TRUTH.top - TRUTH.address)));
      lm[0] = { ...lm[0], x: 0.5 - 0.02 * u };
    },
  });
  const r = computeMetrics(samples, TRUTH, { view: 'face', aspect, timeScale: 1 });
  const head = r.items.find((i) => i.key === 'headLateralTop');
  // 추정 신장 = 코~발목(0.69) / 0.84
  const H = 0.69 / 0.84;
  assert.ok(Math.abs(head.value - (-0.02 / H) * 100) < 0.05, String(head.value));
  assert.equal(head.detail, '타깃 반대쪽');
  assert.ok(!r.items.some((i) => i.key.startsWith('spine')), '정면에서는 척추각 제외');
});

test('후방: 척추 전경각 변화만 계산', () => {
  const samples = makeSamples({
    mutate: (lm, tr) => {
      // 임팩트에 가까워질수록 어깨가 뒤로(일어섬) — 어드레스에서 앞으로 숙인 상태
      const lean = tr < TRUTH.top ? 0.12 : 0.12 - 0.06 * Math.min(1, (tr - TRUTH.top) / (TRUTH.impact - TRUTH.top));
      lm[11] = { ...lm[11], x: 0.45 + lean }; lm[12] = { ...lm[12], x: 0.55 + lean };
    },
  });
  const r = computeMetrics(samples, TRUTH, { view: 'dtl', aspect: 1, timeScale: 1 });
  const keys = r.items.map((i) => i.key);
  assert.deepEqual(keys.slice(0, 3), ['spineAddress', 'spineTopChange', 'spineImpactChange']);
  assert.ok(keys.includes('handSpeed'));
  assert.ok(!keys.some((k) => k.startsWith('head') || k.includes('Sway')), '후방에서는 머리·스웨이 제외');
  const imp = r.items.find((i) => i.key === 'spineImpactChange');
  assert.ok(imp.value < -5, `일어섬 감지: ${imp.value}`);
  assert.match(imp.detail, /일어섬/);
});

test('랜드마크 보간과 척추각', () => {
  const lm = baseLandmarks();
  assert.ok(spineTilt(lm, 1) < 1e-6);
  const a = { t: 0, lm: baseLandmarks() };
  const b = { t: 1, lm: baseLandmarks().map((p) => ({ ...p, x: p.x + 0.1 })) };
  const mid = landmarksAt([a, b], 0.5);
  assert.ok(Math.abs(mid[0].x - 0.55) < 1e-9);
});

test('키 입력 시 % 항목에 cm 환산, 미입력·잘못된 값이면 cm 없음', async () => {
  const { validHeight } = await import('../js/metrics.js');
  const samples = makeSamples({
    mutate: (lm, tr) => {
      const u = Math.min(1, Math.max(0, (tr - TRUTH.address) / (TRUTH.top - TRUTH.address)));
      lm[0] = { ...lm[0], x: 0.5 - 0.02 * u };
    },
  });
  const withH = computeMetrics(samples, TRUTH, { view: 'face', aspect: 1, timeScale: 1, heightCm: 180 });
  const head = withH.items.find((i) => i.key === 'headLateralTop');
  assert.ok(Math.abs(head.cm - (head.value / 100) * 180) < 1e-9);
  assert.ok(head.cm < 0);
  const without = computeMetrics(samples, TRUTH, { view: 'face', aspect: 1, timeScale: 1 });
  const head2 = without.items.find((i) => i.key === 'headLateralTop');
  assert.equal(head2.cm, null);
  assert.equal(head2.value, head.value, '키 입력은 %값에 영향 없음');
  assert.equal(validHeight('175'), 175);
  assert.equal(validHeight(50), null);
  assert.equal(validHeight(''), null);
  assert.equal(validHeight('abc'), null);
});

test('다운스윙 손 속도: 신장/초, 실시간·슬로모션에서 같은 값', async () => {
  const { handSpeedPeak } = await import('../js/metrics.js');
  const a = handSpeedPeak(makeSamples(), TRUTH, 1, 1);
  const slow = makeSamples({ timeScale: 1 / 8 });
  const slowTimes = Object.fromEntries(Object.entries(TRUTH).map(([k, v]) => [k, v * 8]));
  const b = handSpeedPeak(slow, slowTimes, 1, 1 / 8);
  assert.ok(a.heightsPerSec > 0.5, String(a.heightsPerSec));
  assert.ok(Math.abs(a.heightsPerSec - b.heightsPerSec) < 1e-6);
});

test('후방: 다운스윙 손이 공 쪽으로 지나가면 + (오버더톱)', async () => {
  const { handPathOffset } = await import('../js/metrics.js');
  // 다운스윙 동안 손을 공 쪽(골반보다 손이 있는 쪽 = +x)으로 0.04 밀어냄
  const samples = makeSamples({
    mutate: (lm, tr) => {
      if (tr > TRUTH.top && tr < TRUTH.impact) {
        const bump = 0.04 * Math.sin(Math.PI * (tr - TRUTH.top) / (TRUTH.impact - TRUTH.top));
        lm[15] = { ...lm[15], x: lm[15].x + bump }; lm[16] = { ...lm[16], x: lm[16].x + bump };
      }
      // 어드레스에서 손이 골반보다 +x(공 쪽)에 있도록
      lm[23] = { ...lm[23], x: lm[23].x - 0.06 }; lm[24] = { ...lm[24], x: lm[24].x - 0.06 };
    },
  });
  const r = handPathOffset(samples, TRUTH, 1);
  assert.ok(r && r.pct > 0, JSON.stringify(r));
});
