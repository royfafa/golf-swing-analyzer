// 영상 위 오버레이(골격·손 궤적·구간 표시) 그리기

import { LM } from './series.js';
import { handsOf } from './phases.js';

const BONES = [
  [LM.L_SHOULDER, LM.R_SHOULDER], [LM.L_HIP, LM.R_HIP],
  [LM.L_SHOULDER, LM.L_HIP], [LM.R_SHOULDER, LM.R_HIP],
  [LM.L_SHOULDER, LM.L_ELBOW], [LM.L_ELBOW, LM.L_WRIST],
  [LM.R_SHOULDER, LM.R_ELBOW], [LM.R_ELBOW, LM.R_WRIST],
  [LM.L_HIP, LM.L_KNEE], [LM.L_KNEE, LM.L_ANKLE],
  [LM.R_HIP, LM.R_KNEE], [LM.R_KNEE, LM.R_ANKLE],
];
const JOINTS = [LM.NOSE, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

/** 구간별 궤적 색 */
export const SEG_COLORS = {
  back: '#4ea8ff',   // 백스윙
  down: '#ff9f43',   // 다운스윙
  follow: '#c77dff', // 팔로스루
  pre: 'rgba(255,255,255,0.55)',
};

/**
 * 골격 그리기
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} lm 정규화 랜드마크
 * @param {number} w 캔버스 너비(px)
 * @param {number} h 캔버스 높이(px)
 */
export function drawSkeleton(ctx, lm, w, h, { lineWidth = 3, color = '#3ddc84' } = {}) {
  if (!lm) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = lineWidth;
  for (const [a, b] of BONES) {
    const pa = lm[a], pb = lm[b];
    const vis = Math.min(pa.visibility ?? 1, pb.visibility ?? 1);
    ctx.strokeStyle = color;
    ctx.globalAlpha = vis < 0.5 ? 0.35 : 0.95;
    ctx.beginPath();
    ctx.moveTo(pa.x * w, pa.y * h);
    ctx.lineTo(pb.x * w, pb.y * h);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const i of JOINTS) {
    const p = lm[i];
    ctx.fillStyle = i === LM.NOSE ? '#ffd166' : '#ffffff';
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, lineWidth * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * 손 궤적: 현재 시각까지, 구간이 정해져 있으면 구간별 색으로
 * @param {Array<{t:number,lm:Array|null}>} samples
 * @param {number} uptoT 영상 시간
 * @param {Record<string,number>|null} phases
 */
export function drawHandTrail(ctx, samples, uptoT, phases, w, h, lineWidth = 3) {
  const pts = samples.filter((s) => s.lm && s.t <= uptoT + 1e-6);
  if (pts.length < 2) return;
  const segOf = (t) => {
    if (!phases) return 'pre';
    if (t < phases.address) return 'pre';
    if (t <= phases.top) return 'back';
    if (t <= phases.impact) return 'down';
    return 'follow';
  };
  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i < pts.length; i++) {
    const a = handsOf(pts[i - 1].lm), b = handsOf(pts[i].lm);
    ctx.strokeStyle = SEG_COLORS[segOf(pts[i].t)];
    ctx.beginPath();
    ctx.moveTo(a.x * w, a.y * h);
    ctx.lineTo(b.x * w, b.y * h);
    ctx.stroke();
  }
  ctx.restore();
}

/** 어드레스 시점의 머리(코) 위치에 기준 원을 그려 머리 움직임을 눈으로 보게 한다 */
export function drawHeadReference(ctx, lmAddress, w, h) {
  if (!lmAddress) return;
  const p = lmAddress[LM.NOSE];
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x * w, p.y * h, Math.max(10, w * 0.035), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
