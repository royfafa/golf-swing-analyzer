// 테스트용 합성 스윙 데이터 생성기
// 실제 시간 기준으로 손 궤적을 만들고, 슬로모션 배율에 맞춰 영상 시간으로 변환한다.

/** 33개 랜드마크를 기본 자세로 채운다(정규화 좌표) */
export function baseLandmarks() {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.99 }));
  const set = (i, x, y) => { lm[i] = { x, y, z: 0, visibility: 0.99 }; };
  set(0, 0.5, 0.2);              // 코
  set(11, 0.45, 0.3); set(12, 0.55, 0.3);  // 어깨
  set(13, 0.44, 0.42); set(14, 0.56, 0.42); // 팔꿈치
  set(15, 0.49, 0.55); set(16, 0.51, 0.55); // 손목
  set(23, 0.46, 0.55); set(24, 0.54, 0.55); // 골반
  set(25, 0.46, 0.72); set(26, 0.54, 0.72); // 무릎
  set(27, 0.46, 0.89); set(28, 0.54, 0.89); // 발목
  return lm;
}

/** 실제 시간 tr(초)에서의 손 위치(정면 촬영, 타깃 = 화면 오른쪽) */
export const TRUTH = { address: 0.5, top: 1.3, impact: 1.57, finish: 2.2 };
export function handsAt(tr) {
  const { address, top, impact, finish } = TRUTH;
  const addr = { x: 0.5, y: 0.55 };
  const topP = { x: 0.33, y: 0.18 };
  const fin = { x: 0.64, y: 0.16 };
  const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, u)));
  if (tr <= address) return addr;
  if (tr <= top) { const u = ease((tr - address) / (top - address)); return { x: addr.x + (topP.x - addr.x) * u, y: addr.y + (topP.y - addr.y) * u }; }
  if (tr <= impact) {
    // 다운스윙: 가속(제곱)으로 내려와 임팩트에서 가장 낮음
    const u = ((tr - top) / (impact - top)) ** 2;
    return { x: topP.x + (addr.x - topP.x) * u, y: topP.y + (addr.y + 0.01 - topP.y) * u };
  }
  if (tr <= finish) {
    const u = 1 - (1 - (tr - impact) / (finish - impact)) ** 2;
    return { x: addr.x + (fin.x - addr.x) * u, y: addr.y + 0.01 + (fin.y - addr.y - 0.01) * u };
  }
  return fin;
}

/**
 * @param {{timeScale?:number, realFps?:number, duration?:number, mutate?:(lm, tr)=>void}} o
 */
export function makeSamples({ timeScale = 1, realFps = 30, duration = 2.8, mutate } = {}) {
  const out = [];
  for (let i = 0; i * (1 / realFps) <= duration + 1e-9; i++) {
    const tr = i / realFps;
    const lm = baseLandmarks();
    const h = handsAt(tr);
    lm[15] = { ...lm[15], x: h.x - 0.01, y: h.y };
    lm[16] = { ...lm[16], x: h.x + 0.01, y: h.y };
    mutate?.(lm, tr);
    out.push({ t: tr / timeScale, lm });
  }
  return out;
}
