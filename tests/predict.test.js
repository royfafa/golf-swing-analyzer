import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predictSwing, trainingSet, looEvaluate, featuresFrom, beatsBaseline, MIN_SAMPLES } from '../js/predict.js';

// 결정적 의사난수
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/** 손 속도가 빠를수록 멀리, 손 경로가 바깥쪽(+)일수록 왼쪽 출발·오른쪽 휘어짐(슬라이스)인 가상 기록 */
function makeRecords(n, { club = '7i', view = 'dtl' } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const speed = 1.6 + rnd() * 0.8;      // 신장/초
    const path = -4 + rnd() * 8;          // %
    const noise = rnd() * 6 - 3;          // 관계없는 지표
    return {
      id: `r${i}`, view,
      features: { handSpeed: speed, handPathDown: path, tempoRatio: 3 + noise / 10, noise },
      outcome: {
        club, contact: 'good',
        distance: 80 + (speed - 1.6) * 100 + (rnd() * 6 - 3),
        start: path > 1.5 ? -1 : path < -1.5 ? 1 : 0,
        curve: path > 2 ? 2 : path > 0.5 ? 1 : path < -2 ? -2 : path < -0.5 ? -1 : 0,
      },
    };
  });
}

test('데이터가 적으면 예측하지 않고 개수만 알려줌', () => {
  const recs = makeRecords(MIN_SAMPLES - 1);
  const p = predictSwing(recs, recs[0].features, { view: 'dtl', club: '7i' });
  assert.equal(p.distance.count, MIN_SAMPLES - 1);
  assert.equal(p.distance.value, undefined);
});

test('거리: 손 속도와 관계가 있으면 평균만 쓰는 것보다 정확', () => {
  const recs = makeRecords(30);
  const train = trainingSet(recs, { view: 'dtl', club: '7i', target: 'distance' });
  const ev = looEvaluate(train, 'distance');
  assert.ok(ev.mae < ev.baselineMae, `${ev.mae} < ${ev.baselineMae}`);
  assert.ok(beatsBaseline(ev, 'distance'));
  // 빠른 손 속도 → 먼 거리 추측
  const fast = predictSwing(recs, { handSpeed: 2.35, handPathDown: 0, tempoRatio: 3, noise: 0 }, { view: 'dtl', club: '7i' });
  const slow = predictSwing(recs, { handSpeed: 1.65, handPathDown: 0, tempoRatio: 3, noise: 0 }, { view: 'dtl', club: '7i' });
  assert.ok(fast.distance.value > slow.distance.value + 30, `${fast.distance.value} vs ${slow.distance.value}`);
});

test('방향: 손 경로가 바깥쪽이면 오른쪽 휘어짐 추측', () => {
  const recs = makeRecords(30);
  const p = predictSwing(recs, { handSpeed: 2, handPathDown: 3.5, tempoRatio: 3, noise: 0 }, { view: 'dtl', club: null });
  assert.ok(p.curve.value >= 1, JSON.stringify(p.curve));
  assert.equal(p.distance, undefined, '클럽을 고르지 않으면 거리 추측 없음');
});

test('빗맞음·다른 촬영 방향·다른 클럽·자기 자신은 학습에서 제외', () => {
  const recs = makeRecords(10);
  recs[0].outcome.contact = 'mishit';
  recs[1].view = 'face';
  recs[2].outcome.club = 'driver';
  const t = trainingSet(recs, { view: 'dtl', club: '7i', target: 'distance', excludeId: 'r3' });
  assert.equal(t.length, 6);
});

test('분석 결과에서 특징 추출', () => {
  const f = featuresFrom({ tempo: { ratio: 3, backSec: 0.8, downSec: 0.27 }, items: [{ key: 'handSpeed', value: 2 }, { key: 'spineAddress', value: 35 }] });
  assert.deepEqual(f, { tempoRatio: 3, backSec: 0.8, downSec: 0.27, handSpeed: 2 });
});
