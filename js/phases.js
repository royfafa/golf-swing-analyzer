// 손 궤적으로 스윙 4구간(어드레스·탑·임팩트·피니시)의 "제안값"을 만든다.
// 왜글·빈 스윙·걸어 들어오는 동작이 섞이면 틀릴 수 있으므로 최종 값은 반드시 사용자가 확정한다.

import { LM, mid, pointSeries, smooth, speedSeries, argMax, argMin } from './series.js';

export const PHASES = ['address', 'top', 'impact', 'finish'];
export const PHASE_LABEL = { address: '어드레스', top: '백스윙 탑', impact: '임팩트', finish: '피니시' };

/** 양 손목의 중점 = 손 위치 */
export const handsOf = (lm) => mid(lm[LM.L_WRIST], lm[LM.R_WRIST]);

/**
 * @param {Array<{t:number, lm:Array|null}>} samples 영상 시간 t 순으로 정렬된 샘플
 * @param {{aspect:number, timeScale:number}} opt
 * @returns {{times:Record<string,number>|null, warnings:string[], handSeries:Array|null}}
 *   times는 영상 시간(초)
 */
export function suggestPhases(samples, { aspect, timeScale }) {
  const warnings = [];
  const valid = samples.filter((s) => s.lm).length;
  if (samples.length < 8 || valid < samples.length * 0.5) {
    return { times: null, warnings: ['사람이 인식된 프레임이 너무 적어 구간을 제안할 수 없어요. 직접 지정해 주세요.'], handSeries: null };
  }

  const tr = samples.map((s) => s.t * timeScale); // 실제 시간
  const hands = smooth(pointSeries(samples, handsOf, aspect), 3);
  const speed = speedSeries(hands, tr);
  const n = samples.length;
  const idxAtOffset = (i, sec) => {
    // i에서 실제 시간 sec만큼 떨어진 인덱스
    const target = tr[i] + sec;
    let j = i;
    if (sec >= 0) { while (j < n - 1 && tr[j] < target) j++; }
    else { while (j > 0 && tr[j] > target) j--; }
    return j;
  };

  // 1) 다운스윙에서 손이 가장 빠른 지점 근처에서 손이 가장 낮은 곳 = 임팩트
  const peak = argMax(speed);
  const peakSpeed = speed[peak];
  const impact = argMax(hands, idxAtOffset(peak, -0.12), idxAtOffset(peak, 0.12), (p) => p.y);

  // 2) 임팩트 전 2.5초 안에서 손이 가장 높은 곳 = 탑
  const top = argMin(hands, idxAtOffset(impact, -2.5), impact - 1, (p) => p.y);

  // 3) 탑에서 거꾸로 가며 손이 멈춰 있던 첫 지점 = 어드레스(테이크어웨이 직전)
  const still = peakSpeed * 0.08;
  let address = 0;
  for (let i = top - 1; i >= 1; i--) {
    if (speed[i] < still && speed[i - 1] < still) { address = i; break; }
  }

  // 4) 임팩트 후 1.5초 안에서 손이 가장 높은 곳을 지나 멈추는 지점 = 피니시
  const high = argMin(hands, impact + 1, idxAtOffset(impact, 1.5), (p) => p.y);
  let finish = n - 1;
  for (let i = Math.max(high, impact + 1); i < n - 1; i++) {
    if (speed[i] < still && speed[i + 1] < still) { finish = i; break; }
  }
  if (high < 0) finish = n - 1;

  const ok = address < top && top < impact && impact < finish;
  if (!ok || top < 0) {
    return { times: null, warnings: ['스윙 순서를 찾지 못했어요. 구간을 직접 지정해 주세요.'], handSeries: hands };
  }

  const back = tr[top] - tr[address];
  const down = tr[impact] - tr[top];
  if (back < 0.35 || back > 2.5) warnings.push('백스윙 시간이 일반 범위를 벗어나요. 어드레스·탑 위치를 확인해 주세요.');
  if (down < 0.12 || down > 0.7) warnings.push('다운스윙 시간이 일반 범위를 벗어나요. 탑·임팩트 위치를 확인해 주세요.');
  if (address === 0) warnings.push('어드레스 정지 구간을 찾지 못했어요. 트림 시작을 조금 앞당기거나 직접 지정해 주세요.');

  return {
    times: {
      address: samples[address].t,
      top: samples[top].t,
      impact: samples[impact].t,
      finish: samples[finish].t,
    },
    warnings,
    handSeries: hands,
  };
}

/** 구간 시각이 올바른 순서인지 확인 */
export function phasesInOrder(times) {
  return PHASES.every((k) => Number.isFinite(times[k])) &&
    times.address < times.top && times.top < times.impact && times.impact < times.finish;
}

/**
 * 학습 모드 자동 트림: 영상 전체를 듬성듬성 분석한 샘플에서 임팩트 위치를 어림잡아
 * 임팩트 전 before초 ~ 후 after초(실제 시간) 구간을 돌려준다.
 * 4구간 제안이 실패하면 손이 가장 빠른 순간을 임팩트로 본다.
 * @returns {null|{start:number, end:number, impactGuess:number, method:'phases'|'peakSpeed'}}
 */
export function autoTrimWindow(samples, { aspect, timeScale, duration, before = 2.2, after = 1.3 }) {
  const sug = suggestPhases(samples, { aspect, timeScale });
  let impact = sug.times?.impact;
  let method = 'phases';
  if (!Number.isFinite(impact)) {
    if (samples.filter((s) => s.lm).length < 3) return null;
    const hands = pointSeries(samples, handsOf, aspect);
    if (!hands) return null;
    const tr = samples.map((s) => s.t * timeScale);
    const sp = speedSeries(smooth(hands, 3), tr);
    const i = argMax(sp);
    if (i < 0 || !(sp[i] > 0)) return null;
    impact = samples[i].t;
    method = 'peakSpeed';
  }
  return {
    start: Math.max(0, impact - before / timeScale),
    end: Math.min(duration - 1e-3, impact + after / timeScale),
    impactGuess: impact,
    method,
  };
}
