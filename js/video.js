// <video> 탐색 유틸. 모든 대기에는 타임아웃을 둬서 iOS Safari에서 seeked가 오지 않아도 멈추지 않게 한다.

export const SEEK_TIMEOUT_MS = 500;

/**
 * 영상 시간 t로 이동하고 프레임이 준비될 때까지 기다린다.
 * @returns {Promise<boolean>} 제때 완료되면 true, 타임아웃이면 false(호출 측에서 집계)
 */
export function seekTo(video, t, timeoutMs = SEEK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const target = Math.max(0, Math.min(t, (video.duration || t) - 1e-3));
    if (Math.abs(video.currentTime - target) < 1e-4 && video.readyState >= 2) {
      resolve(true);
      return;
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      resolve(ok);
    };
    const onSeeked = () => {
      // seeked 직후 아직 새 프레임이 합성되지 않았을 수 있어, 지원 시 프레임 콜백을 한 번 더 기다린다(최대 80ms)
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => finish(true));
        setTimeout(() => finish(true), 80);
      } else {
        finish(true);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    video.addEventListener('seeked', onSeeked);
    video.currentTime = target;
  });
}

/**
 * 스크러버처럼 연속으로 이동 요청이 올 때 "마지막 요청만" 처리하는 큐.
 * 이동이 끝나지 않은 상태에서 새 요청이 쌓여 디코더가 밀리는 것을 막는다.
 */
export function createSeekQueue(video, onDone) {
  let busy = false;
  let pending = null;
  let timeouts = 0;
  async function request(t) {
    pending = t;
    if (busy) return;
    busy = true;
    while (pending !== null) {
      const x = pending;
      pending = null;
      const ok = await seekTo(video, x);
      if (!ok) timeouts++;
    }
    busy = false;
    onDone?.();
  }
  return { request, get timeouts() { return timeouts; }, get busy() { return busy; } };
}

/**
 * iOS Safari는 사용자 동작으로 한 번 재생하기 전에는 프레임을 디코딩하지 않는 경우가 있다.
 * 버튼 클릭 핸들러 안에서 호출해 디코더를 깨운다.
 */
export async function primeVideo(video) {
  try {
    video.muted = true;
    const p = video.play();
    if (p) await Promise.race([p, new Promise((r) => setTimeout(r, 300))]);
  } catch { /* 자동 재생 거부는 무시 */ }
  video.pause();
}

/**
 * 재생 프레임 콜백으로 fps를 "참고용"으로 추정한다. 화면 주사율보다 높은 fps는 낮게 나올 수 있다.
 * 0.25배속으로 0.8초 재생하며 연속 프레임 간 mediaTime 간격의 최솟값을 쓴다.
 * @returns {Promise<number|null>}
 */
export async function estimateFpsByPlayback(video) {
  if (typeof video.requestVideoFrameCallback !== 'function') return null;
  const startAt = video.currentTime;
  const rate = video.playbackRate;
  const times = [];
  let stop = false;
  const tick = (_now, meta) => {
    times.push(meta.mediaTime);
    if (!stop) video.requestVideoFrameCallback(tick);
  };
  try {
    video.muted = true;
    video.playbackRate = 0.25;
    video.requestVideoFrameCallback(tick);
    await Promise.race([video.play(), new Promise((r) => setTimeout(r, 500))]);
    await new Promise((r) => setTimeout(r, 800));
  } catch {
    /* 재생 불가 */
  } finally {
    stop = true;
    video.pause();
    video.playbackRate = rate;
    await seekTo(video, startAt);
  }
  const deltas = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 1e-4) deltas.push(d);
  }
  if (deltas.length < 3) return null;
  return 1 / Math.min(...deltas);
}
