// 프레임별 랜드마크에서 시계열(좌표·속도)을 만드는 순수 함수 모음.

/** MediaPipe Pose 랜드마크 번호 */
export const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
};

/**
 * 정규화 좌표(0~1)를 "화면 높이 = 1" 단위로 바꾼다. 가로·세로 비율 왜곡을 없애기 위함.
 * @param {{x:number,y:number}} p
 * @param {number} aspect 영상 가로/세로 비
 */
export function toUnit(p, aspect) {
  return { x: p.x * aspect, y: p.y };
}

export function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 프레임 배열에서 특정 점의 시계열을 뽑는다. 검출 실패 프레임은 앞뒤 값으로 선형 보간한다.
 * @param {Array<{t:number, lm:Array|null}>} frames
 * @param {(lm:Array)=>{x:number,y:number}} pick 랜드마크 배열 → 점
 * @param {number} aspect
 * @returns {Array<{x:number,y:number}>|null} 유효 프레임이 하나도 없으면 null
 */
export function pointSeries(frames, pick, aspect) {
  const raw = frames.map((f) => (f.lm ? toUnit(pick(f.lm), aspect) : null));
  const known = raw.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  if (known.length === 0) return null;
  const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]) { out[i] = raw[i]; continue; }
    // 앞뒤로 가장 가까운 유효 프레임 찾기
    let prev = -1, next = -1;
    for (const k of known) {
      if (k < i) prev = k;
      else { next = k; break; }
    }
    if (prev < 0) out[i] = { ...raw[next] };
    else if (next < 0) out[i] = { ...raw[prev] };
    else {
      const r = (i - prev) / (next - prev);
      out[i] = {
        x: raw[prev].x + (raw[next].x - raw[prev].x) * r,
        y: raw[prev].y + (raw[next].y - raw[prev].y) * r,
      };
    }
  }
  return out;
}

/** 가운데 정렬 이동평균(창 크기 w, 홀수) */
export function smooth(series, w) {
  if (w <= 1) return series.map((p) => ({ ...p }));
  const h = Math.floor(w / 2);
  return series.map((_, i) => {
    let sx = 0, sy = 0, n = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(series.length - 1, i + h); k++) {
      sx += series[k].x; sy += series[k].y; n++;
    }
    return { x: sx / n, y: sy / n };
  });
}

/**
 * 중앙차분으로 속력(단위/실제초)을 구한다.
 * @param {Array<{x:number,y:number}>} s
 * @param {number[]} tr 실제 시간(초)
 */
export function speedSeries(s, tr) {
  const n = s.length;
  return s.map((_, i) => {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const dt = tr[b] - tr[a];
    return dt > 0 ? dist(s[a], s[b]) / dt : 0;
  });
}

/** [from, to] 구간에서 fn 값이 가장 큰 인덱스 */
export function argMax(arr, from = 0, to = arr.length - 1, fn = (v) => v) {
  let best = -1, bv = -Infinity;
  for (let i = Math.max(0, from); i <= Math.min(arr.length - 1, to); i++) {
    const v = fn(arr[i]);
    if (v > bv) { bv = v; best = i; }
  }
  return best;
}

/** [from, to] 구간에서 fn 값이 가장 작은 인덱스 */
export function argMin(arr, from = 0, to = arr.length - 1, fn = (v) => v) {
  return argMax(arr, from, to, (v) => -fn(v));
}
