// MediaPipe Pose Landmarker 로딩·추론. 영상은 기기 밖으로 나가지 않는다(브라우저 안에서 WASM으로 처리).

export const MEDIAPIPE_VERSION = '1.2.2';
const VISION_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
export const MODEL_URLS = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};

let landmarker = null;
let loadedKey = '';
let delegate = '';
// VIDEO 모드는 타임스탬프가 항상 증가해야 하므로 여러 번 분석해도 계속 이어서 증가시킨다
let lastTs = 0;

/**
 * @param {'lite'|'full'} model
 * @param {(msg:string)=>void} [onStatus]
 * @returns {Promise<{delegate:string, model:string}>}
 */
export async function loadPose(model = 'full', onStatus) {
  if (landmarker && loadedKey === model) return { delegate, model };
  if (landmarker) { landmarker.close(); landmarker = null; }
  onStatus?.('자세 인식 엔진 불러오는 중…');
  const vision = await import(`${VISION_BASE}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${VISION_BASE}/wasm`);
  const make = (d) => vision.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URLS[model], delegate: d },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  onStatus?.(`자세 인식 모델(${model}) 내려받는 중…`);
  try {
    landmarker = await make('GPU');
    delegate = 'GPU';
  } catch {
    // 일부 기기(특히 구형 iOS)는 WebGL 위임이 실패하므로 CPU로 다시 시도
    landmarker = await make('CPU');
    delegate = 'CPU';
  }
  loadedKey = model;
  return { delegate, model };
}

/**
 * 캔버스 한 장에서 자세를 찾는다.
 * @param {HTMLCanvasElement} canvas
 * @param {number} stepMs 직전 호출과의 실제 시간 간격(ms). 추적 안정화를 위해 타임스탬프에 반영한다.
 * @returns {Array<{x:number,y:number,z:number,visibility:number}>|null}
 */
export function detectPose(canvas, stepMs) {
  if (!landmarker) throw new Error('자세 인식 엔진이 아직 준비되지 않았어요.');
  lastTs += Math.max(1, Math.round(stepMs));
  const res = landmarker.detectForVideo(canvas, lastTs);
  const lm = res?.landmarks?.[0];
  if (!lm) return null;
  // 저장 용량을 줄이기 위해 소수점 4자리로 자른다
  return lm.map((p) => ({
    x: +p.x.toFixed(4),
    y: +p.y.toFixed(4),
    z: +(p.z ?? 0).toFixed(4),
    visibility: +(p.visibility ?? 1).toFixed(3),
  }));
}

/** 새 영상 분석을 시작할 때 이전 영상의 추적 상태를 끊기 위해 타임스탬프를 크게 건너뛴다 */
export function resetTracking() {
  lastTs += 10_000;
}
