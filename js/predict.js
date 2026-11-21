// "내 실제 결과로 학습"하는 공 방향·거리 추측.
// 휴대폰 영상만으로는 페이스 각도·스핀을 잴 수 없으므로 물리 계산을 하지 않는다.
// 대신 사용자가 기록한 실제 결과와 스윙 지표를 모아, 지표가 비슷했던 내 과거 스윙들의 결과로 추측한다(가중 k-최근접 이웃).
// 특징별 가중치는 학습 데이터에서 결과와의 상관(절대값)으로 정해, 결과와 무관한 지표의 영향을 줄인다.
// 정확도는 "하나씩 빼고 예측(LOO)"으로 계산해 항상 함께 보여준다.

export const MIN_SAMPLES = 6;
export const K = 5;

export const CLUBS = [
  ['driver', '드라이버'], ['3w', '3번 우드'], ['5w', '5번 우드'], ['ut', '유틸리티'],
  ['4i', '4번 아이언'], ['5i', '5번 아이언'], ['6i', '6번 아이언'], ['7i', '7번 아이언'],
  ['8i', '8번 아이언'], ['9i', '9번 아이언'], ['pw', '피칭 웨지'], ['aw', '어프로치 웨지'],
  ['sw', '샌드 웨지'], ['lw', '로브 웨지'],
];
export const CLUB_LABEL = Object.fromEntries(CLUBS);

/** 출발 방향(타깃을 바라봤을 때): -1 왼쪽, 0 똑바로, 1 오른쪽 */
export const START_LABEL = { '-1': '왼쪽', 0: '똑바로', 1: '오른쪽' };
/** 휘어짐: -2 왼쪽으로 크게 ~ 2 오른쪽으로 크게 */
export const CURVE_LABEL = { '-2': '왼쪽으로 크게', '-1': '왼쪽으로 조금', 0: '거의 없음', 1: '오른쪽으로 조금', 2: '오른쪽으로 크게' };

/**
 * 분석 결과에서 예측에 쓸 숫자 특징을 뽑는다(기록에 함께 저장).
 * @param {{tempo:object, items:Array<{key:string,value:number}>}} result
 */
export function featuresFrom(result) {
  const f = {};
  const t = result.tempo || {};
  if (Number.isFinite(t.ratio)) f.tempoRatio = t.ratio;
  if (Number.isFinite(t.backSec)) f.backSec = t.backSec;
  if (Number.isFinite(t.downSec)) f.downSec = t.downSec;
  for (const it of result.items || []) {
    if (Number.isFinite(it.value) && it.key !== 'spineAddress') f[it.key] = it.value;
  }
  return f;
}

/** 학습에 쓸 기록: 같은 촬영 방향, 정타, 해당 결과값이 있는 것(거리는 같은 클럽만) */
export function trainingSet(records, { view, club, target, excludeId = null }) {
  return records.filter((r) => {
    const o = r.outcome;
    if (!o || r.id === excludeId || r.view !== view || o.contact === 'mishit' || !r.features) return false;
    if (target === 'distance') return o.club === club && Number.isFinite(o.distance) && o.distance > 0;
    return Number.isFinite(o[target]);
  });
}

const targetOf = (r, target) => r.outcome[target];

function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
function std(a) { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); }
function corr(x, y) {
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/**
 * 학습 데이터로 특징 정규화 값과 가중치를 만든다.
 * @returns {{keys:string[], mu:object, sd:object, w:object}}
 */
export function fitScaler(train, target, queryFeatures) {
  const keys = Object.keys(queryFeatures).filter((k) => train.every((r) => Number.isFinite(r.features[k])));
  const ys = train.map((r) => targetOf(r, target));
  const mu = {}, sd = {}, w = {};
  for (const k of keys) {
    const xs = train.map((r) => r.features[k]);
    mu[k] = mean(xs);
    sd[k] = std(xs);
    w[k] = sd[k] > 1e-9 ? Math.abs(corr(xs, ys)) : 0;
  }
  const used = keys.filter((k) => w[k] > 0);
  // 모든 가중치가 0이면(결과값이 전부 같은 경우 등) 균등 가중
  if (!used.length) for (const k of keys) if (sd[k] > 1e-9) { w[k] = 1; used.push(k); }
  return { keys: used, mu, sd, w };
}

function distance(a, b, sc) {
  let s = 0;
  for (const k of sc.keys) s += sc.w[k] * ((a[k] - b[k]) / sc.sd[k]) ** 2;
  return Math.sqrt(s);
}

/**
 * 가중 k-최근접 이웃 예측
 * @returns {null|{value:number, neighbors:Array<{record:object, d:number}>, keys:string[]}}
 */
export function knn(train, features, target, k = K) {
  if (train.length < 2) return null;
  const sc = fitScaler(train, target, features);
  if (!sc.keys.length) return null;
  const ranked = train.map((r) => ({ record: r, d: distance(features, r.features, sc) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, Math.min(k, train.length));
  const ws = ranked.map((n) => 1 / (n.d + 0.25));
  const value = ranked.reduce((s, n, i) => s + ws[i] * targetOf(n.record, target), 0) / ws.reduce((s, v) => s + v, 0);
  // 가중치가 큰(결과와 관계가 큰) 지표 순서
  const keys = [...sc.keys].sort((a, b) => sc.w[b] - sc.w[a]);
  return { value, neighbors: ranked, keys };
}

/**
 * 하나씩 빼고 예측해 정확도를 잰다. 기준선(평균/최빈값만 쓰는 예측)과 함께 반환.
 */
export function looEvaluate(train, target) {
  const errs = [], base = [], hits = [], baseHits = [];
  for (let i = 0; i < train.length; i++) {
    const rest = train.filter((_, j) => j !== i);
    const truth = targetOf(train[i], target);
    const p = knn(rest, train[i].features, target);
    if (!p) continue;
    const m = mean(rest.map((r) => targetOf(r, target)));
    errs.push(Math.abs(p.value - truth));
    base.push(Math.abs(m - truth));
    hits.push(Math.round(p.value) === truth ? 1 : 0);
    baseHits.push(Math.round(m) === truth ? 1 : 0);
  }
  if (!errs.length) return null;
  return {
    n: errs.length,
    mae: mean(errs),
    baselineMae: mean(base),
    hitRate: mean(hits),
    baselineHitRate: mean(baseHits),
  };
}

/** 이웃들의 범주 분포(예: {"0":2,"1":3}) */
function distribution(neighbors, target) {
  const d = {};
  for (const n of neighbors) {
    const v = String(targetOf(n.record, target));
    d[v] = (d[v] || 0) + 1;
  }
  return d;
}

/**
 * 새 스윙의 결과 추측
 * @param {Array} records 저장된 기록 전체
 * @param {object} features featuresFrom(현재 결과)
 * @param {{view:string, club:string|null, excludeId?:string}} opt
 */
export function predictSwing(records, features, { view, club, excludeId = null }) {
  const out = {};
  // 거리: 같은 촬영 방향 + 같은 클럽
  if (club) {
    const train = trainingSet(records, { view, club, target: 'distance', excludeId });
    out.distance = { count: train.length, need: MIN_SAMPLES };
    if (train.length >= MIN_SAMPLES) {
      const p = knn(train, features, 'distance');
      if (p) {
        const vals = p.neighbors.map((n) => n.record.outcome.distance);
        out.distance.value = p.value;
        out.distance.min = Math.min(...vals);
        out.distance.max = Math.max(...vals);
        out.distance.clubAvg = mean(train.map((r) => r.outcome.distance));
        out.distance.eval = looEvaluate(train, 'distance');
        out.distance.keys = p.keys;
      }
    }
  }
  // 방향: 같은 촬영 방향(클럽 무관)
  for (const target of ['start', 'curve']) {
    const train = trainingSet(records, { view, target, excludeId });
    out[target] = { count: train.length, need: MIN_SAMPLES };
    if (train.length >= MIN_SAMPLES) {
      const p = knn(train, features, target);
      if (p) {
        out[target].value = Math.round(p.value);
        out[target].dist = distribution(p.neighbors, target);
        out[target].eval = looEvaluate(train, target);
        out[target].keys = p.keys;
      }
    }
  }
  return out;
}

/** 모델이 "평균만 쓰는 것"보다 나은지 */
export function beatsBaseline(ev, target) {
  if (!ev) return false;
  return target === 'distance' ? ev.mae < ev.baselineMae * 0.95 : ev.hitRate > ev.baselineHitRate + 0.05;
}
