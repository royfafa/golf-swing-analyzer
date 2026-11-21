// 촬영 모드(일반/슬로모션)에 따라 "영상 속 시간"을 "실제 시간"으로 바꾸는 규칙을 담은 모듈.
// DOM에 의존하지 않는 순수 함수만 두어 Node 테스트로 검증할 수 있게 한다.

/** 흔히 쓰이는 프레임레이트 값. 측정값을 가장 가까운 값으로 맞춘다. */
export const COMMON_FPS = [24, 25, 30, 48, 50, 60, 90, 100, 120, 240, 480];

/** 측정된 fps를 흔한 값으로 보정한다. 오차가 8%를 넘으면 반올림한 원래 값을 돌려준다. */
export function snapFps(measured) {
  if (!Number.isFinite(measured) || measured <= 0) return 30;
  let best = COMMON_FPS[0];
  for (const f of COMMON_FPS) {
    if (Math.abs(f - measured) < Math.abs(best - measured)) best = f;
  }
  return Math.abs(best - measured) / best <= 0.08 ? best : Math.round(measured);
}

/**
 * 촬영 모드에 따라 시간 배율을 계산한다.
 * - 일반 모드: 영상 1초 = 실제 1초
 * - 슬로모션 모드
 *   - native(원본 고프레임 파일, 예: 240fps로 저장된 파일): 영상 1초 = 실제 1초, 대신 프레임이 촘촘함
 *   - slowed(느리게 재생되도록 내보낸 파일, 예: 240fps 촬영 → 30fps 재생): 영상 1초 = 실제 30/240초
 *   - auto: 파일 fps가 90 이상이면 native, 아니면 slowed로 본다
 *
 * @param {{mode:'normal'|'slowmo', fileFps:number, captureFps?:number, fileType?:'auto'|'native'|'slowed'}} opt
 * @returns {{timeScale:number, effectiveFps:number, resolvedType:'realtime'|'native'|'slowed'}}
 *   timeScale: 실제 시간 = 영상 시간 × timeScale
 *   effectiveFps: 실제 시간 1초당 담긴 프레임 수(분석 해상도)
 */
export function computeTimeScale({ mode, fileFps, captureFps = 240, fileType = 'auto' }) {
  const fps = fileFps > 0 ? fileFps : 30;
  if (mode !== 'slowmo') {
    return { timeScale: 1, effectiveFps: fps, resolvedType: 'realtime' };
  }
  let type = fileType;
  if (type === 'auto') type = fps >= 90 ? 'native' : 'slowed';
  if (type === 'native') {
    return { timeScale: 1, effectiveFps: fps, resolvedType: 'native' };
  }
  const cap = captureFps > 0 ? captureFps : 240;
  return { timeScale: fps / cap, effectiveFps: cap, resolvedType: 'slowed' };
}

/** 자세 추론 샘플링 상한(실제 시간 기준 초당 프레임 수) */
export const MAX_SAMPLE_REAL_FPS = 30;

/**
 * 자세 추론 샘플 간격(영상 시간, 초)을 정한다.
 * 실제 시간 기준으로 최대 30fps 간격이 되도록 하되, 원본 1프레임보다 촘촘하게는 잡지 않는다.
 * 예) 일반 60fps 파일 → 2프레임마다 / 240fps 원본 → 8프레임마다 / 240fps 촬영→30fps 평탄화 파일 → 8프레임마다(모두 실제 30fps 간격)
 */
export function samplingStep({ fileFps, timeScale, maxRealFps = MAX_SAMPLE_REAL_FPS }) {
  const frameDur = 1 / (fileFps > 0 ? fileFps : 30);
  const wanted = 1 / maxRealFps / (timeScale > 0 ? timeScale : 1);
  // 원본 프레임 간격의 정수배로 맞춰 항상 같은 위치의 프레임을 읽게 한다
  const k = Math.max(1, Math.round(wanted / frameDur));
  return k * frameDur;
}

/** 영상 시간(초) → 실제 시간(초) */
export function toRealSeconds(videoSeconds, timeScale) {
  return videoSeconds * (timeScale > 0 ? timeScale : 1);
}

/** 원본 프레임 k의 중앙 시각. 프레임 경계로 이동하면 브라우저마다 이전 프레임이 잡힐 수 있어 중앙을 쓴다. */
export function frameCenter(t, fileFps) {
  const fps = fileFps > 0 ? fileFps : 30;
  return (Math.floor(t * fps + 1e-6) + 0.5) / fps;
}

/** 트림 구간 권장/허용 한계(실제 시간, 초) */
export const TRIM_RECOMMENDED_REAL = 3;
export const TRIM_MAX_REAL = 6;
