// 확정된 4구간을 바탕으로 촬영 방향별 "신뢰할 수 있는 지표"만 계산한다.
// - 정면(face-on): 템포, 머리 좌우·상하 이동, 골반·상체 스웨이
// - 후방(down-the-line): 템포, 척추 전경각 유지
// 이동량은 카메라 거리에 무관하도록 픽셀·cm가 아닌 "추정 신장 대비 %"로 낸다.

import { LM, mid, dist, toUnit, pointSeries, smooth, speedSeries } from './series.js';
import { handsOf } from './phases.js';

/** 코~발목 거리 ÷ 신장의 평균 비율(성인 인체 비례 근사). 서 있는 자세에서의 값이다. */
const NOSE_TO_ANKLE_RATIO = 0.84;

/** 영상 시간 t의 랜드마크를 앞뒤 샘플로 선형 보간한다. */
export function landmarksAt(samples, t) {
  let lo = -1, hi = -1;
  for (let i = 0; i < samples.length; i++) {
    if (!samples[i].lm) continue;
    if (samples[i].t <= t) lo = i;
    if (samples[i].t >= t) { hi = i; break; }
  }
  if (lo < 0 && hi < 0) return null;
  if (lo < 0) return samples[hi].lm;
  if (hi < 0 || hi === lo) return samples[lo].lm;
  const a = samples[lo], b = samples[hi];
  const r = (t - a.t) / (b.t - a.t);
  return a.lm.map((p, k) => {
    const q = b.lm[k];
    return {
      x: p.x + (q.x - p.x) * r,
      y: p.y + (q.y - p.y) * r,
      z: (p.z ?? 0) + ((q.z ?? 0) - (p.z ?? 0)) * r,
      visibility: Math.min(p.visibility ?? 1, q.visibility ?? 1),
    };
  });
}

/** 입력 키 검증: 100~230cm 범위의 숫자만 인정 */
export function validHeight(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 100 && n <= 230 ? Math.round(n) : null;
}

/** 평가 등급: good / ok / warn */
function grade(value, goodMax, okMax) {
  const v = Math.abs(value);
  if (v <= goodMax) return 'good';
  if (v <= okMax) return 'ok';
  return 'warn';
}

/**
 * 템포: 비율(배율 무관)과 절대 시간(배율 의존)을 분리해 계산한다.
 * @param {Record<string,number>} times 영상 시간
 * @param {number} timeScale
 */
export function computeTempo(times, timeScale) {
  const backVideo = times.top - times.address;
  const downVideo = times.impact - times.top;
  const ratio = backVideo / downVideo; // 영상 시간끼리 나누므로 일정 배율이면 배율이 상쇄된다
  return {
    ratio,
    ratioGrade: ratio >= 2.5 && ratio <= 3.5 ? 'good' : ratio >= 2 && ratio <= 4 ? 'ok' : 'warn',
    backSec: backVideo * timeScale,
    downSec: downVideo * timeScale,
    totalSec: (times.impact - times.address) * timeScale,
  };
}

/** 추정 신장(화면 높이=1 단위): 샘플 중 코~발목이 가장 긴 자세(가장 곧게 선 순간) 기준 */
export function estimateHeightUnits(samples, aspect) {
  let best = 0;
  for (const s of samples) {
    if (!s.lm) continue;
    const nose = toUnit(s.lm[LM.NOSE], aspect);
    const ankle = toUnit(mid(s.lm[LM.L_ANKLE], s.lm[LM.R_ANKLE]), aspect);
    best = Math.max(best, dist(nose, ankle));
  }
  return best > 0 ? best / NOSE_TO_ANKLE_RATIO : 0;
}

/** 척추 기울기(도): 골반 중점→어깨 중점 선이 수직선과 이루는 각 */
export function spineTilt(lm, aspect) {
  const hip = toUnit(mid(lm[LM.L_HIP], lm[LM.R_HIP]), aspect);
  const sh = toUnit(mid(lm[LM.L_SHOULDER], lm[LM.R_SHOULDER]), aspect);
  const dx = sh.x - hip.x, dy = hip.y - sh.y; // 위쪽이 +y가 되도록
  return (Math.atan2(Math.abs(dx), dy) * 180) / Math.PI;
}

const avgVis = (lm, ids) => ids.reduce((s, i) => s + (lm[i].visibility ?? 1), 0) / ids.length;

/**
 * @param {Array<{t:number, lm:Array|null}>} samples
 * @param {Record<string,number>} times 확정된 구간(영상 시간)
 * @param {{view:'face'|'dtl', aspect:number, timeScale:number, heightCm?:number|null}} opt
 *   heightCm: 사용자가 입력한 키(cm). 있으면 % 항목에 cm 환산값(cm)을 덧붙인다.
 * @returns {{tempo:object, items:Array<object>, notes:string[]}}
 */
export function computeMetrics(samples, times, { view, aspect, timeScale, heightCm = null }) {
  const h = validHeight(heightCm);
  const at = {};
  for (const k of ['address', 'top', 'impact', 'finish']) at[k] = landmarksAt(samples, times[k]);
  const tempo = computeTempo(times, timeScale);
  const items = [];
  const notes = [];

  if (!at.address || !at.top || !at.impact) {
    notes.push('구간 시점의 자세를 찾지 못해 템포만 계산했어요.');
    return { tempo, items, notes };
  }

  if (view === 'face') {
    const H = estimateHeightUnits(samples, aspect);
    if (!(H > 0)) {
      notes.push('몸 전체(코~발목)가 인식되지 않아 이동량(신장 대비 %)을 계산하지 못했어요. 발까지 화면에 들어오게 촬영해 주세요.');
      return { tempo, items, notes };
    }
    const pct = (d) => (d / H) * 100;
    const P = (lm, f) => toUnit(f(lm), aspect);
    const nose = (lm) => lm[LM.NOSE];
    const hipMid = (lm) => mid(lm[LM.L_HIP], lm[LM.R_HIP]);
    const shMid = (lm) => mid(lm[LM.L_SHOULDER], lm[LM.R_SHOULDER]);

    // 타깃 방향: 백스윙에서 손이 움직인 반대쪽. +1이면 타깃이 화면 오른쪽.
    const handDx = P(at.top, handsOf).x - P(at.address, handsOf).x;
    const target = handDx < 0 ? 1 : -1;
    const toward = (dx) => dx * target; // +: 타깃 쪽, -: 타깃 반대쪽
    const side = (v) => (v >= 0 ? '타깃 쪽' : '타깃 반대쪽');
    const vert = (dy) => (dy > 0 ? '아래로' : '위로');

    const a = P(at.address, nose);
    const headTopDx = toward(P(at.top, nose).x - a.x);
    const headImpDx = toward(P(at.impact, nose).x - a.x);
    const headImpDy = P(at.impact, nose).y - a.y;
    const headTopDy = P(at.top, nose).y - a.y;

    items.push({
      key: 'headLateral', label: '머리 좌우 이동 (어드레스→임팩트)',
      value: pct(headImpDx), unit: '%', signed: true, detail: side(headImpDx),
      grade: grade(pct(headImpDx), 3, 6),
      hint: `신장 대비. 약 3% 이내면 안정적이에요. ${h ? `(내 키 ${h}cm 기준 3% ≈ ${(h * 0.03).toFixed(1)}cm)` : '(설정에서 키를 입력하면 cm로도 보여줘요)'}`,
    });
    items.push({
      key: 'headLateralTop', label: '머리 좌우 이동 (어드레스→탑)',
      value: pct(headTopDx), unit: '%', signed: true, detail: side(headTopDx),
      grade: grade(pct(headTopDx), 3, 6),
      hint: '백스윙 중 머리가 타깃 반대쪽으로 크게 밀리면 스웨이 신호예요.',
    });
    const dyMax = Math.abs(headTopDy) > Math.abs(headImpDy) ? headTopDy : headImpDy;
    items.push({
      key: 'headVertical', label: '머리 상하 이동 (최대)',
      value: pct(Math.abs(dyMax)), unit: '%', detail: vert(dyMax),
      grade: grade(pct(dyMax), 2.5, 5),
      hint: '어드레스 대비 탑·임팩트 중 큰 값. 아래로 크게 내려가거나 일어서면 타점이 흔들려요.',
    });

    const hipTop = toward(P(at.top, hipMid).x - P(at.address, hipMid).x);
    const hipImp = toward(P(at.impact, hipMid).x - P(at.address, hipMid).x);
    const shTop = toward(P(at.top, shMid).x - P(at.address, shMid).x);
    items.push({
      key: 'hipSwayBack', label: '골반 스웨이 (어드레스→탑)',
      value: pct(hipTop), unit: '%', signed: true, detail: side(hipTop),
      grade: hipTop >= 0 ? 'good' : grade(pct(hipTop), 3, 6),
      hint: '백스윙에서 골반이 타깃 반대쪽으로 밀리는 정도.',
    });
    items.push({
      key: 'hipShiftImpact', label: '골반 이동 (어드레스→임팩트)',
      value: pct(hipImp), unit: '%', signed: true, detail: side(hipImp),
      grade: hipImp >= 0 ? (pct(hipImp) <= 8 ? 'good' : 'ok') : grade(pct(hipImp), 1.5, 4),
      hint: '임팩트 때 골반이 타깃 쪽으로 약간 이동해 있는 것이 일반적이에요.',
    });
    items.push({
      key: 'upperSwayBack', label: '상체 스웨이 (어드레스→탑)',
      value: pct(shTop), unit: '%', signed: true, detail: side(shTop),
      grade: shTop >= 0 ? 'good' : grade(pct(shTop), 4, 8),
      hint: '어깨 중심이 백스윙에서 타깃 반대쪽으로 밀리는 정도.',
    });
    for (const it of items) if (it.unit === '%') it.cm = h ? (it.value / 100) * h : null;
    notes.push(`이동량(%)은 영상 속 가장 곧게 선 자세의 코~발목 길이로 화면 속 신장을 추정해 계산했어요(인체 평균 비율 ${NOSE_TO_ANKLE_RATIO}).${h ? ` cm 값은 입력한 키 ${h}cm로 환산한 추정치예요.` : ''} 절대값보다 내 기록끼리 비교할 때 더 정확해요.`);
    notes.push(`타깃 방향은 백스윙 손 움직임으로 판단했어요: 화면 ${target > 0 ? '오른쪽' : '왼쪽'}.`);
  } else {
    const tilt = {};
    const vis = {};
    const ids = [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP];
    for (const k of ['address', 'top', 'impact']) {
      tilt[k] = spineTilt(at[k], aspect);
      vis[k] = avgVis(at[k], ids);
    }
    const lowVis = (k) => vis[k] < 0.6;
    items.push({
      key: 'spineAddress', label: '어드레스 척추 전경각',
      value: tilt.address, unit: '°', grade: 'info',
      hint: '골반→어깨 선이 수직과 이루는 각. 기준값으로만 사용해요.',
      lowConfidence: lowVis('address'),
    });
    const dTop = tilt.top - tilt.address;
    const dImp = tilt.impact - tilt.address;
    items.push({
      key: 'spineTopChange', label: '전경각 변화 (어드레스→탑)',
      value: dTop, unit: '°', signed: true, detail: dTop < 0 ? '일어섬' : '숙여짐',
      grade: grade(dTop, 4, 8),
      hint: '탑에서는 팔·어깨가 몸을 가려 인식이 흔들릴 수 있어요.',
      lowConfidence: lowVis('top'),
    });
    items.push({
      key: 'spineImpactChange', label: '전경각 변화 (어드레스→임팩트)',
      value: dImp, unit: '°', signed: true, detail: dImp < 0 ? '일어섬(얼리 익스텐션 의심)' : '숙여짐',
      grade: grade(dImp, 5, 10),
      hint: '임팩트에서 상체가 일어서며 각이 줄면 얼리 익스텐션 신호예요.',
      lowConfidence: lowVis('impact'),
    });
    if (Object.values(vis).some((v) => v < 0.6)) {
      notes.push('후방 촬영은 탑·임팩트에서 팔과 어깨가 몸통을 가려 관절 인식 신뢰도가 낮아질 수 있어요. "신뢰도 낮음" 표시 항목은 참고만 하세요.');
    }
    const path = handPathOffset(samples, times, aspect);
    if (path) {
      items.push({
        key: 'handPathDown', label: '다운스윙 손 경로 (백스윙 대비)',
        value: path.pct, unit: '%', signed: true,
        detail: path.pct > 0 ? '바깥쪽(공 쪽) — 오버더톱 경향' : '안쪽(몸 쪽) — 인사이드 경향',
        grade: 'info',
        hint: '같은 높이에서 다운스윙 손이 백스윙 손보다 공 쪽(+)/몸 쪽(−)으로 지나간 정도(신장 대비). 손 경로이며 클럽 헤드 경로와는 다를 수 있어요.',
        lowConfidence: path.levels < 3,
      });
    }
  }

  // 다운스윙 최대 손 속도(두 방향 공통). 샘플이 실제 30fps 간격이라 실제보다 낮게 나오므로 기록끼리 비교용.
  const speed = handSpeedPeak(samples, times, aspect, timeScale);
  if (speed) {
    const h = validHeight(heightCm);
    items.push({
      key: 'handSpeed', label: '다운스윙 최대 손 속도',
      value: speed.heightsPerSec, unit: '신장/초',
      detail: h ? `약 ${(speed.heightsPerSec * h / 100).toFixed(1)}m/s` : '',
      grade: 'info',
      hint: `샘플 간격(실제 약 ${Math.round(speed.sampleMs)}ms) 때문에 실제보다 낮게 측정돼요. 내 기록끼리 비교하는 용도예요.${view === 'dtl' ? ' 후방 영상은 카메라 쪽 움직임이 빠져 더 낮게 나와요.' : ''}`,
    });
  }
  return { tempo, items, notes };
}

/** 다운스윙(탑~임팩트 직후) 손의 최대 속력: 신장/초 */
export function handSpeedPeak(samples, times, aspect, timeScale) {
  const H = estimateHeightUnits(samples, aspect);
  const hands = pointSeries(samples, handsOf, aspect);
  if (!(H > 0) || !hands) return null;
  const tr = samples.map((s) => s.t * timeScale);
  const sp = speedSeries(smooth(hands, 3), tr);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].t >= times.top && samples[i].t <= times.impact + 1e-6) peak = Math.max(peak, sp[i]);
  }
  if (!(peak > 0)) return null;
  const sampleMs = samples.length > 1 ? ((tr[tr.length - 1] - tr[0]) / (samples.length - 1)) * 1000 : 0;
  return { heightsPerSec: peak / H, sampleMs };
}

/** 경로(시간순 점 배열)가 높이 y를 처음 지나는 x */
function xAtY(path, y) {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if ((a.y - y) * (b.y - y) <= 0 && a.y !== b.y) return a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
  }
  return null;
}

/**
 * 후방 영상: 같은 높이에서 다운스윙 손이 백스윙 손보다 공 쪽(+)으로 지나간 정도(신장 대비 %)
 * 공 쪽 방향은 어드레스에서 골반 중심→손 방향으로 판단한다(오른손/왼손잡이 자동).
 */
export function handPathOffset(samples, times, aspect) {
  const H = estimateHeightUnits(samples, aspect);
  const all = pointSeries(samples, handsOf, aspect);
  if (!(H > 0) || !all) return null;
  const hands = smooth(all, 3);
  const back = [], down = [];
  samples.forEach((s, i) => {
    if (s.t >= times.address && s.t <= times.top + 1e-6) back.push(hands[i]);
    if (s.t >= times.top - 1e-6 && s.t <= times.impact + 1e-6) down.push(hands[i]);
  });
  const lmA = landmarksAt(samples, times.address);
  if (back.length < 3 || down.length < 3 || !lmA) return null;
  const hipA = toUnit(mid(lmA[LM.L_HIP], lmA[LM.R_HIP]), aspect);
  const ballSide = Math.sign(back[0].x - hipA.x) || 1;
  const yTop = down[0].y, yImp = down[down.length - 1].y;
  const diffs = [];
  for (const r of [0.2, 0.35, 0.5, 0.65, 0.8]) {
    const y = yTop + (yImp - yTop) * r;
    const xb = xAtY(back, y), xd = xAtY(down, y);
    if (xb !== null && xd !== null) diffs.push((xd - xb) * ballSide);
  }
  if (!diffs.length) return null;
  return { pct: (diffs.reduce((a, b) => a + b, 0) / diffs.length / H) * 100, levels: diffs.length };
}
