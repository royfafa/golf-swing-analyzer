// 트림 구간을 실제 시간 기준 최대 30fps 간격으로 샘플링하며 자세를 추론한다.
// 각 이동에는 타임아웃이 있고, 매 프레임마다 진행률 보고와 중단 확인을 한다.

import { seekTo } from './video.js';
import { detectPose, resetTracking } from './pose.js';

/** 자세 추론용 캔버스의 긴 변 길이. 모델 입력이 256px이므로 이 이상은 속도만 느려진다. */
const ANALYSIS_LONG_SIDE = 480;

/**
 * @param {HTMLVideoElement} video
 * @param {{start:number, end:number, step:number, timeScale:number,
 *   onProgress?:(p:{done:number,total:number,fps:number})=>void,
 *   shouldAbort?:()=>boolean}} opt
 * @returns {Promise<{samples:Array<{t:number,lm:Array|null}>, diag:object, aborted:boolean}>}
 */
export async function analyzeRange(video, { start, end, step, timeScale, onProgress, shouldAbort }) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = ANALYSIS_LONG_SIDE / Math.max(vw, vh);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vw * Math.min(1, scale));
  canvas.height = Math.round(vh * Math.min(1, scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  const times = [];
  for (let t = start; t <= end + 1e-6; t += step) times.push(t);

  resetTracking();
  const samples = [];
  let timeouts = 0, detected = 0;
  const t0 = performance.now();
  let aborted = false;
  const stepMs = step * timeScale * 1000;

  for (let i = 0; i < times.length; i++) {
    if (shouldAbort?.()) { aborted = true; break; }
    const ok = await seekTo(video, times[i]);
    if (!ok) timeouts++;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const lm = detectPose(canvas, stepMs);
    if (lm) detected++;
    samples.push({ t: times[i], lm });
    const elapsed = (performance.now() - t0) / 1000;
    onProgress?.({ done: i + 1, total: times.length, fps: (i + 1) / Math.max(elapsed, 1e-3) });
    // 메인 스레드를 잠깐 양보해 화면 갱신·중단 버튼 입력을 받는다
    await new Promise((r) => setTimeout(r, 0));
  }

  const wall = (performance.now() - t0) / 1000;
  return {
    samples,
    aborted,
    diag: {
      sampleCount: samples.length,
      plannedCount: times.length,
      detected,
      detectRate: samples.length ? detected / samples.length : 0,
      seekTimeouts: timeouts,
      wallSec: wall,
      procFps: samples.length / Math.max(wall, 1e-3),
      analysisSize: `${canvas.width}×${canvas.height}`,
    },
  };
}
