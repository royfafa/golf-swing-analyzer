// 화면 흐름: 업로드 → 촬영 정보 → 트림(필수) → 자세 분석 → 구간 확정(반자동) → 결과/저장

import {
  COMMON_FPS, snapFps, computeTimeScale, samplingStep, toRealSeconds, frameCenter,
  TRIM_RECOMMENDED_REAL, TRIM_MAX_REAL, MAX_SAMPLE_REAL_FPS,
} from './timebase.js';
import { readVideoMeta } from './mp4meta.js';
import { seekTo, createSeekQueue, primeVideo, estimateFpsByPlayback } from './video.js';
import { loadPose, MEDIAPIPE_VERSION } from './pose.js';
import { analyzeRange } from './analyze.js';
import { suggestPhases, phasesInOrder, PHASES, PHASE_LABEL } from './phases.js';
import { computeMetrics, landmarksAt, validHeight } from './metrics.js';
import { drawSkeleton, drawHandTrail, drawHeadReference, SEG_COLORS } from './render.js';
import { saveRecord, listRecords, deleteRecord, storageEstimate } from './store.js';
import { createLineTool, autoAnchors, drawLines } from './lines.js';
import { initCompare } from './compare.js';
import { initLearn } from './learn.js';
import { predictSwing, featuresFrom } from './predict.js';
import { mountOutcomeForm, predictionHTML, learningStatusHTML, outcomeSummary, hasOutcome, withFeatures, emptyOutcome } from './outcome.js';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const overlay = $('#overlay');

/* ---------------- 설정 저장(localStorage는 실패해도 동작하게) ---------------- */
const SETTINGS_KEY = 'swing-analyzer:settings';
const settings = { model: 'full', heightCm: null, lastClub: null };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* 무시 */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 무시 */ } };

/* ---------------- 상태 ---------------- */
const S = {
  file: null, url: null, meta: null, playbackFps: null, duration: 0,
  view: null, mode: 'normal', fileFps: 30, captureFps: 240, fileType: 'auto',
  tb: computeTimeScale({ mode: 'normal', fileFps: 30 }),
  trim: { start: null, end: null },
  samples: null, analysisDiag: null, poseInfo: null,
  suggested: null, phases: null, edited: {}, activePhase: 'impact', warnings: [],
  result: null, snapshots: null, snapshotUrls: [], saved: false,
  analyzing: false, abort: false,
};

const seekQueue = createSeekQueue(video, () => { updateTimecode(); draw(); });

/* ---------------- 공통 UI ---------------- */
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const show = (sel, on = true) => { $(sel).hidden = !on; };

function setSeg(name, value) {
  document.querySelectorAll(`.seg[data-name="${name}"] button`).forEach((b) => {
    const on = b.dataset.value === value;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));
  });
}

function bindSeg(name, onChange) {
  document.querySelectorAll(`.seg[data-name="${name}"] button`).forEach((b) => {
    b.addEventListener('click', () => { setSeg(name, b.dataset.value); onChange(b.dataset.value); });
  });
}

/* ---------------- 탭 ---------------- */
function openTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `panel-${name}`; });
  if (name !== 'analyze' && !video.paused) video.pause();
  if (name === 'history') renderHistory();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => openTab(t.dataset.tab)));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.goto)));

/* ---------------- 1. 업로드 ---------------- */
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) await loadFile(file);
});

function resetAnalysis() {
  S.samples = null; S.analysisDiag = null; S.suggested = null; S.phases = null;
  S.edited = {}; S.warnings = []; S.result = null; S.snapshots = null; S.saved = false;
  S.snapshotUrls.forEach((u) => URL.revokeObjectURL(u));
  S.snapshotUrls = [];
  show('#step-phases', false);
  show('#step-result', false);
  $('#player').classList.remove('no-stick');
  show('#progress', false);
}

function waitForMetadata(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const done = (fn, arg) => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onErr);
      fn(arg);
    };
    const onMeta = () => done(resolve);
    const onErr = () => done(reject, new Error('decode'));
    const timer = setTimeout(() => done(reject, new Error('timeout')), timeoutMs);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onErr);
  });
}

async function loadFile(file) {
  resetAnalysis();
  if (S.url) URL.revokeObjectURL(S.url);
  S.file = file;
  S.url = URL.createObjectURL(file);
  S.meta = null;
  S.playbackFps = null;
  S.trim = { start: null, end: null };
  S.outcome = null;
  lineTool.clear();
  lineTool.setMode(null);
  video.src = S.url;
  try {
    await waitForMetadata();
  } catch {
    toast('이 영상을 브라우저가 열지 못했어요. 카메라 설정의 "호환성 우선(H.264)"으로 찍거나 다른 브라우저로 시도해 주세요.', 6000);
    return;
  }
  const ar = video.videoWidth / video.videoHeight || 16 / 9;
  $('#stage').style.setProperty('--ar', `${video.videoWidth} / ${video.videoHeight}`);
  $('#stage').style.setProperty('--ar-num', String(ar));

  S.meta = await readVideoMeta(file);
  S.duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (S.meta?.durationSec || 0);

  // 파일 fps 제안: 컨테이너 정보 우선, 없으면 재생 기반 참고값
  let suggested = S.meta ? snapFps(S.meta.modeFps) : null;
  if (!suggested) {
    S.playbackFps = await estimateFpsByPlayback(video);
    suggested = S.playbackFps ? snapFps(S.playbackFps) : 30;
  }
  S.fileFps = suggested;
  // 고프레임 원본이면 슬로모션 모드를 기본 제안
  S.mode = suggested >= 90 ? 'slowmo' : 'normal';
  setSeg('mode', S.mode);
  fillFpsSelect();

  show('#step-setup');
  show('#player');
  show('#step-trim');
  show('#diag');
  show('#step-analyze');
  await primeVideo(video);
  await seekTo(video, frameCenter(0, S.fileFps));
  // 실제 시간 3초 이하 영상이면 전체를 기본 트림으로
  const realLen = toRealSeconds(S.duration, computeTimeScale(currentTbInput()).timeScale);
  if (realLen <= TRIM_RECOMMENDED_REAL + 0.5) S.trim = { start: 0, end: S.duration - 1e-3 };
  recomputeTimebase();
  if (!S.view) $('.seg[data-name="view"]').classList.add('needs-choice');
  $('#step-setup').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- 2. 촬영 정보 ---------------- */
function fillFpsSelect() {
  const sel = $('#fps-select');
  const values = new Set(COMMON_FPS);
  values.add(S.fileFps);
  sel.innerHTML = [...values].sort((a, b) => a - b)
    .map((f) => `<option value="${f}" ${f === S.fileFps ? 'selected' : ''}>${f} fps</option>`).join('');
  let hint;
  if (S.meta) {
    hint = `파일 정보에서 읽은 값: 대표 ${fmt(S.meta.modeFps, 2)}fps (평균 ${fmt(S.meta.avgFps, 2)}fps)`;
    if (S.meta.isVFR) hint += ' · ⚠ 가변 프레임레이트';
  } else if (S.playbackFps) {
    hint = `파일 정보를 읽지 못해 재생으로 추정한 참고값 ${fmt(S.playbackFps, 1)}fps예요. 실제와 다르면 직접 고르세요.`;
  } else {
    hint = '파일 정보를 읽지 못했어요. 촬영한 fps를 직접 골라 주세요.';
  }
  $('#fps-hint').textContent = hint;
}

const currentTbInput = () => ({ mode: S.mode, fileFps: S.fileFps, captureFps: S.captureFps, fileType: S.fileType });

function recomputeTimebase() {
  const prev = S.tb;
  S.tb = computeTimeScale(currentTbInput());
  show('#slowmo-fields', S.mode === 'slowmo');
  if (S.samples && (prev.timeScale !== S.tb.timeScale || prev.effectiveFps !== S.tb.effectiveFps)) {
    resetAnalysis();
    toast('촬영 정보가 바뀌어 다시 분석해야 해요.');
  }
  renderTimebase();
  renderTrim();
  renderAnalyzeStep();
  renderDiag();
  updateTimecode();
}

function samplingInfo() {
  const step = samplingStep({ fileFps: S.fileFps, timeScale: S.tb.timeScale });
  return { step, realMs: step * S.tb.timeScale * 1000, realFps: 1 / (step * S.tb.timeScale) };
}

function renderTimebase() {
  const { timeScale, resolvedType, effectiveFps } = S.tb;
  const real = toRealSeconds(S.duration, timeScale);
  const typeText = {
    realtime: '실시간 영상 (영상 1초 = 실제 1초)',
    native: `원본 고프레임 파일 (영상 1초 = 실제 1초, 초당 ${S.fileFps}프레임)`,
    slowed: `느리게 재생되는 파일 (영상 1초 = 실제 ${fmt(timeScale, 4)}초, ${fmt(1 / timeScale, 1)}배 느림)`,
  }[resolvedType];
  const warns = [];
  if (resolvedType === 'slowed') {
    warns.push('아이폰 슬로모션은 앞뒤 약 1초가 보통 속도로 재생돼요. 스윙이 그 구간에 걸리지 않도록 트림해 주세요.');
    if (S.meta?.isVFR) warns.push('파일에서 가변 프레임레이트가 감지됐어요. 구간마다 속도가 달라 절대 시간(초)이 틀릴 수 있고, 템포 비율은 스윙 전체가 같은 속도 구간에 있을 때만 정확해요.');
  }
  if (S.mode === 'normal' && S.fileFps <= 30) warns.push(`30fps 이하 영상은 다운스윙이 6~8프레임뿐이라 임팩트 시점 오차가 ±${Math.round(500 / S.fileFps)}ms 정도 있어요. 60fps 촬영을 권장해요.`);
  if (S.mode === 'normal' && S.fileFps >= 90) warns.push('고프레임 파일이에요. 슬로모션 모드(원본 고프레임)를 선택해도 결과는 같지만, 가이드에 맞춰 설정을 확인해 주세요.');
  if (S.mode === 'slowmo' && resolvedType === 'native' && S.fileFps < 90) warns.push(`파일이 ${S.fileFps}fps인데 "원본 고프레임"으로 지정했어요. 공유받은 슬로모션이라면 "느리게 재생됨"이 맞을 가능성이 높아요.`);
  $('#timebase-box').innerHTML = `
    <div>${typeText}</div>
    <div>영상 길이 <b>${fmt(S.duration, 2)}초</b> → 실제 시간 <b>${fmt(real, 2)}초</b></div>
    <div class="muted" style="margin:2px 0 0;font-size:12.5px">시점 정밀도: 원본 1프레임 = 실제 ${fmt(1000 / effectiveFps, 1)}ms</div>
    ${warns.map((w) => `<div class="warn">⚠ ${w}</div>`).join('')}`;
}

bindSeg('view', (v) => {
  S.view = v;
  $('.seg[data-name="view"]').classList.remove('needs-choice');
  $('#view-hint').textContent = v === 'face'
    ? '정면: 템포 · 머리 좌우/상하 이동 · 골반/상체 스웨이를 계산해요. (척추 전경각 제외)'
    : '후방: 템포 · 척추 전경각 유지를 계산해요. (스웨이·머리 좌우 이동 제외)';
  renderAnalyzeStep();
  if (S.result) buildResult();
  draw();
});
bindSeg('mode', (v) => { S.mode = v; recomputeTimebase(); });
bindSeg('fileType', (v) => { S.fileType = v; recomputeTimebase(); });
$('#fps-select').addEventListener('change', (e) => { S.fileFps = Number(e.target.value); recomputeTimebase(); });
$('#capture-fps').addEventListener('change', (e) => { S.captureFps = Number(e.target.value); recomputeTimebase(); });

/* ---------------- 플레이어 ---------------- */
function frameDur() { return 1 / S.fileFps; }

function updateTimecode() {
  const t = video.currentTime || 0;
  $('#timecode').textContent =
    `영상 ${fmt(t, 3)}초 · 실제 ${fmt(toRealSeconds(t, S.tb.timeScale), 3)}초 · 프레임 ${Math.floor(t * S.fileFps + 1e-6)}`;
  if (S.duration > 0 && document.activeElement !== $('#scrub')) {
    $('#scrub').value = String(Math.round((t / S.duration) * 1000));
  }
  const head = $('#trim-head');
  if (S.duration > 0) head.style.left = `${(t / S.duration) * 100}%`;
}

$('#scrub').addEventListener('input', (e) => {
  if (!video.paused) video.pause();
  seekQueue.request((Number(e.target.value) / 1000) * S.duration);
});

function stepTo(t) {
  if (!video.paused) video.pause();
  const clamped = Math.max(0, Math.min(S.duration - 1e-3, t));
  seekQueue.request(frameCenter(clamped, S.fileFps));
}
$('#btn-prev-frame').addEventListener('click', () => stepTo(frameCenter(video.currentTime, S.fileFps) - frameDur()));
$('#btn-next-frame').addEventListener('click', () => stepTo(frameCenter(video.currentTime, S.fileFps) + frameDur()));
function sampleJump(dir) {
  const t = video.currentTime;
  if (S.samples?.length) {
    const list = dir > 0 ? S.samples.find((s) => s.t > t + 1e-4) : [...S.samples].reverse().find((s) => s.t < t - 1e-4);
    if (list) { stepTo(list.t); return; }
  }
  stepTo(t + dir * samplingInfo().step);
}
$('#btn-prev-sample').addEventListener('click', () => sampleJump(-1));
$('#btn-next-sample').addEventListener('click', () => sampleJump(1));

$('#btn-play').addEventListener('click', async () => {
  if (video.paused) {
    const hasTrim = S.trim.start !== null && S.trim.end !== null;
    if (hasTrim && (video.currentTime < S.trim.start || video.currentTime >= S.trim.end - 0.01)) {
      await seekTo(video, S.trim.start);
    }
    video.playbackRate = Number($('#rate').value);
    try { await video.play(); } catch { toast('재생을 시작하지 못했어요.'); }
  } else {
    video.pause();
  }
});
$('#rate').addEventListener('change', (e) => { video.playbackRate = Number(e.target.value); });
video.addEventListener('play', () => { $('#btn-play').textContent = '⏸'; loop(); });
video.addEventListener('pause', () => { $('#btn-play').textContent = '▶︎'; updateTimecode(); draw(); });
video.addEventListener('seeked', () => { updateTimecode(); draw(); });

function loop() {
  if (video.paused) return;
  // 트림 구간 안에서 반복 재생
  if (S.trim.end !== null && S.trim.start !== null && video.currentTime >= S.trim.end) {
    video.currentTime = S.trim.start;
  }
  updateTimecode();
  draw();
  requestAnimationFrame(loop);
}

/** 오버레이 그리기 */
function draw() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(overlay.clientWidth * dpr), h = Math.round(overlay.clientHeight * dpr);
  if (!w || !h) return;
  if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  drawPose(ctx, w, h);
  lineTool.draw(ctx, w, h, currentAnchors());
}

/** 자동 보조선 기준점: 확정(또는 제안)된 어드레스 자세 */
function currentAnchors() {
  if (!S.samples?.length || !S.phases) return null;
  return autoAnchors(landmarksAt(S.samples, S.phases.address));
}

function drawPose(ctx, w, h) {
  if (!S.samples?.length) return;
  const t = video.currentTime;
  const first = S.samples[0].t, last = S.samples[S.samples.length - 1].t;
  if (t < first - 0.05 || t > last + 0.05) return;
  const lw = Math.max(2, w / 180);
  if (S.phases && S.view === 'face') drawHeadReference(ctx, landmarksAt(S.samples, S.phases.address), w, h);
  drawHandTrail(ctx, S.samples, t, S.phases, w, h, lw);
  drawSkeleton(ctx, landmarksAt(S.samples, t), w, h, { lineWidth: lw });
}

/* ---------------- 보조선 ---------------- */
const lineTool = createLineTool(overlay, {
  onChange: () => { draw(); renderDrawTools(); },
  onHint: (m) => { $('#draw-hint').textContent = m; },
});
function renderDrawTools() {
  const st = lineTool.state;
  $('#btn-draw-line').classList.toggle('is-on', st.mode === 'line');
  $('#btn-draw-ball').classList.toggle('is-on', st.mode === 'ball');
  $('#btn-draw-toggle').textContent = st.visible ? '👁 숨기기' : '👁 보이기';
  if (!st.mode && st.ball) {
    $('#draw-hint').textContent = currentAnchors()
      ? '빨강 = 공→어깨, 노랑 = 공→손 (어드레스 자세 기준, 점선은 연장선). 어드레스를 다시 지정하면 함께 바뀌어요.'
      : '공 위치를 저장했어요. 자세 분석을 마치면 공→어깨, 공→손 선이 그려져요.';
  }
}
$('#btn-draw-line').addEventListener('click', () => { if (!video.paused) video.pause(); lineTool.setMode('line'); });
$('#btn-draw-ball').addEventListener('click', () => {
  if (!video.paused) video.pause();
  const m = lineTool.setMode('ball');
  if (m && S.view === 'face') $('#draw-hint').textContent += ' (자동선은 후방 영상에서 의미가 있어요)';
});
$('#btn-draw-undo').addEventListener('click', () => { if (!lineTool.undo()) toast('되돌릴 선이 없어요.'); });
$('#btn-draw-clear').addEventListener('click', () => { lineTool.clear(); lineTool.setMode(null); });
$('#btn-draw-toggle').addEventListener('click', () => lineTool.toggleVisible());
new ResizeObserver(() => draw()).observe(overlay);

/* ---------------- 3. 트림 ---------------- */
$('#btn-trim-start').addEventListener('click', () => {
  const t = frameCenter(video.currentTime, S.fileFps);
  S.trim.start = t;
  if (S.trim.end !== null && S.trim.end <= t) S.trim.end = null;
  onTrimChanged();
});
$('#btn-trim-end').addEventListener('click', () => {
  const t = frameCenter(video.currentTime, S.fileFps);
  S.trim.end = t;
  if (S.trim.start !== null && S.trim.start >= t) S.trim.start = null;
  onTrimChanged();
});

function onTrimChanged() {
  if (S.samples) { resetAnalysis(); toast('구간이 바뀌어 다시 분석해야 해요.'); }
  renderTrim();
  renderAnalyzeStep();
  renderDiag();
}

function trimState() {
  const { start, end } = S.trim;
  if (start === null || end === null) return { ok: false, msg: '시작과 끝을 모두 지정해 주세요.' };
  const len = end - start;
  const real = toRealSeconds(len, S.tb.timeScale);
  const { step, realMs } = samplingInfo();
  const count = Math.floor(len / step) + 1;
  const base = `영상 ${fmt(start, 2)}~${fmt(end, 2)}초 (${fmt(len, 2)}초) = 실제 ${fmt(real, 2)}초 · 샘플 ${count}개 (실제 ${fmt(realMs, 1)}ms 간격)`;
  if (real > TRIM_MAX_REAL) return { ok: false, msg: `${base}\n너무 길어요. 실제 ${TRIM_MAX_REAL}초 이하로 잘라 주세요.` };
  if (real < 0.8) return { ok: false, msg: `${base}\n너무 짧아요. 어드레스부터 피니시까지 포함해 주세요.` };
  if (real > TRIM_RECOMMENDED_REAL + 0.5) return { ok: true, msg: `${base}\n권장(약 ${TRIM_RECOMMENDED_REAL}초)보다 길어요. 분석이 느려질 수 있어요.`, count };
  return { ok: true, msg: base, count };
}

function renderTrim() {
  const { start, end } = S.trim;
  const sel = $('#trim-sel');
  if (S.duration > 0 && start !== null) {
    const e = end ?? start;
    sel.style.left = `${(start / S.duration) * 100}%`;
    sel.style.width = `${Math.max(0.5, ((e - start) / S.duration) * 100)}%`;
    sel.hidden = false;
  } else {
    sel.hidden = true;
  }
  const st = trimState();
  const info = $('#trim-info');
  info.textContent = st.msg;
  info.style.whiteSpace = 'pre-line';
  info.classList.toggle('bad', !st.ok && start !== null && end !== null);
}

/* ---------------- 4. 분석 ---------------- */
function renderAnalyzeStep() {
  const st = trimState();
  const btn = $('#btn-analyze');
  let desc;
  if (!S.view) desc = '먼저 2단계에서 촬영 방향(정면/후방)을 선택해 주세요.';
  else if (!st.ok) desc = '먼저 3단계에서 스윙 구간을 잘라 주세요.';
  else desc = `샘플 ${st.count}개를 실제 시간 기준 최대 ${MAX_SAMPLE_REAL_FPS}fps 간격으로 분석해요. 처음 한 번은 자세 인식 모델(약 6~9MB)을 내려받아요.`;
  $('#analyze-desc').textContent = desc;
  btn.disabled = !S.view || !st.ok || S.analyzing;
}

$('#btn-abort').addEventListener('click', () => { S.abort = true; $('#progress-text').textContent = '중단하는 중…'; });

$('#btn-analyze').addEventListener('click', async () => {
  if (S.analyzing) return;
  if (learnApi?.busy) { toast('학습 모드에서 영상을 분석 중이에요. 끝난 뒤에 다시 시도해 주세요.'); return; }
  const st = trimState();
  if (!S.view || !st.ok) return;
  resetAnalysis();
  S.analyzing = true; S.abort = false;
  renderAnalyzeStep();
  video.pause();
  show('#progress');
  show('#btn-abort');
  $('#progress-fill').style.width = '0%';
  const setText = (m) => { $('#progress-text').textContent = m; };
  try {
    await primeVideo(video);
    S.poseInfo = await loadPose(settings.model, setText);
    renderDiag();
    const { step } = samplingInfo();
    const res = await analyzeRange(video, {
      start: S.trim.start, end: S.trim.end, step, timeScale: S.tb.timeScale,
      shouldAbort: () => S.abort,
      onProgress: ({ done, total, fps }) => {
        $('#progress-fill').style.width = `${(done / total) * 100}%`;
        setText(`${done} / ${total} 프레임 · 처리 속도 ${fmt(fps, 1)}fps`);
      },
    });
    S.analysisDiag = res.diag;
    renderDiag();
    if (res.aborted) { setText('중단했어요.'); return; }
    S.samples = res.samples;
    setText(`완료 · ${res.diag.sampleCount}프레임 · 인식률 ${Math.round(res.diag.detectRate * 100)}% · ${fmt(res.diag.procFps, 1)}fps`);
    if (res.diag.detectRate < 0.5) toast('사람 인식률이 낮아요. 몸 전체가 보이는지, 밝기가 충분한지 확인해 주세요.', 5000);
    startPhaseReview();
  } catch (err) {
    console.error(err);
    const msg = String(err?.message || err);
    setText('분석 실패');
    toast(/fetch|network|import|Failed to/i.test(msg)
      ? '자세 인식 엔진을 내려받지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.'
      : `분석 중 오류가 났어요: ${msg}`, 6000);
  } finally {
    S.analyzing = false;
    show('#btn-abort', false);
    renderAnalyzeStep();
  }
});

/* ---------------- 5. 구간 확정 ---------------- */
function startPhaseReview() {
  const sug = suggestPhases(S.samples, { aspect: video.videoWidth / video.videoHeight, timeScale: S.tb.timeScale });
  S.warnings = sug.warnings;
  if (sug.times) {
    S.suggested = { ...sug.times };
  } else {
    // 제안 실패 시 트림 구간을 균등 분할한 임시값(반드시 직접 지정)
    const { start, end } = S.trim;
    const at = (r) => frameCenter(start + (end - start) * r, S.fileFps);
    S.suggested = { address: at(0.1), top: at(0.45), impact: at(0.65), finish: at(0.9) };
    S.edited = {};
  }
  S.phases = { ...S.suggested };
  S.activePhase = 'impact';
  show('#step-phases');
  renderPhases();
  stepTo(S.phases.impact);
  $('#step-phases').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const PHASE_COLOR = { address: SEG_COLORS.pre, top: SEG_COLORS.back, impact: SEG_COLORS.down, finish: SEG_COLORS.follow };

function renderPhases() {
  $('#phase-chips').innerHTML = PHASES.map((k) => `
    <button type="button" class="phase-chip ${k === S.activePhase ? 'is-active' : ''} ${S.edited[k] ? 'is-edited' : ''}" data-phase="${k}">
      <b><span class="dot" style="background:${PHASE_COLOR[k]}"></span>${PHASE_LABEL[k]}</b>
      ${fmt(S.phases[k], 3)}초
    </button>`).join('');
  $('#phase-chips').querySelectorAll('.phase-chip').forEach((b) => b.addEventListener('click', () => {
    S.activePhase = b.dataset.phase;
    renderPhases();
    stepTo(S.phases[S.activePhase]);
  }));
  $('#btn-set-phase').textContent = `현재 프레임을 ${PHASE_LABEL[S.activePhase]}(으)로 지정`;
  const warns = [...S.warnings];
  if (!S.edited.impact) warns.push('임팩트 프레임을 영상으로 직접 확인해 주세요. (원본 1프레임 단위로 조정 가능)');
  $('#phase-warnings').innerHTML = warns.map((w) => `<li>${w}</li>`).join('');
  draw();
  renderDrawTools();
}

$('#btn-set-phase').addEventListener('click', () => {
  const t = frameCenter(video.currentTime, S.fileFps);
  const first = S.samples[0].t, last = S.samples[S.samples.length - 1].t;
  if (t < first - 1e-3 || t > last + 1e-3) { toast('분석한 구간 밖이에요. 트림 구간 안에서 지정해 주세요.'); return; }
  const next = { ...S.phases, [S.activePhase]: t };
  if (!phasesInOrder(next)) { toast('순서가 맞지 않아요: 어드레스 < 탑 < 임팩트 < 피니시'); return; }
  S.phases = next;
  S.edited[S.activePhase] = true;
  // 다음 구간으로 자동 이동
  const i = PHASES.indexOf(S.activePhase);
  if (i < PHASES.length - 1 && !S.edited[PHASES[i + 1]]) {
    S.activePhase = PHASES[i + 1];
    stepTo(S.phases[S.activePhase]);
  }
  renderPhases();
  if (S.result) { S.result = null; show('#step-result', false); $('#player').classList.remove('no-stick'); }
});
$('#btn-reset-phases').addEventListener('click', () => {
  S.phases = { ...S.suggested };
  S.edited = {};
  renderPhases();
  stepTo(S.phases[S.activePhase]);
});
$('#btn-confirm').addEventListener('click', async () => {
  if (!phasesInOrder(S.phases)) { toast('구간 순서를 확인해 주세요.'); return; }
  buildResult();
  show('#step-result');
  $('#player').classList.add('no-stick');
  $('#step-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  await makeSnapshots();
});

/* ---------------- 6. 결과 ---------------- */
function buildResult() {
  S.result = computeMetrics(S.samples, S.phases, {
    view: S.view, aspect: video.videoWidth / video.videoHeight, timeScale: S.tb.timeScale,
    heightCm: settings.heightCm,
  });
  S.saved = false;
  S.savedRecord = null;
  if (!S.outcome) S.outcome = emptyOutcome(settings.lastClub);
  $('#btn-save').disabled = false;
  $('#btn-save').textContent = '기록에 저장';
  renderResult();
  mountOutcomeForm($('#outcome-form'), S.outcome, onOutcomeChange);
  renderPrediction();
}

/* ---------------- 공 방향·거리 추측 ---------------- */
function featureLabels() {
  const m = { tempoRatio: '템포 비율', backSec: '백스윙 시간', downSec: '다운스윙 시간' };
  for (const it of S.result?.items || []) m[it.key] = it.label;
  return m;
}
let predictSeq = 0;
async function renderPrediction() {
  if (!S.result) return;
  const seq = ++predictSeq;
  let records = [];
  try { records = withFeatures(await listRecords()); } catch { /* 저장소를 못 열면 데이터 0개로 표시 */ }
  if (seq !== predictSeq) return;
  const pred = predictSwing(records, featuresFrom(S.result), {
    view: S.view, club: S.outcome?.club || null, excludeId: S.savedRecord?.id ?? null,
  });
  $('#predict-body').innerHTML = predictionHTML(pred, { view: S.view, club: S.outcome?.club || null, featureLabels: featureLabels() });
}
function onOutcomeChange(o) {
  const clubChanged = o.club !== S.outcome?.club;
  S.outcome = o;
  if (o.club) { settings.lastClub = o.club; saveSettings(); }
  if (clubChanged) renderPrediction();
  if (S.saved) {
    $('#btn-save').disabled = false;
    $('#btn-save').textContent = '결과 변경 저장';
  }
}

function renderResult() {
  const { tempo, items, notes } = S.result;
  const gradeText = { good: '좋음', ok: '보통', warn: '주의', info: '참고' };
  const order = { warn: 0, ok: 1, good: 2 };
  const valueText = (it) => {
    const sign = it.signed && it.value > 0 ? '+' : '';
    const cm = Number.isFinite(it.cm) ? ` <span class="cm-inline">(${it.signed && it.cm > 0 ? '+' : ''}${fmt(it.cm, 1)}cm)</span>` : '';
    return `${sign}${fmt(it.value, 1)}${it.unit === '신장/초' ? '' : it.unit}${cm}`;
  };
  // 한 줄 요약 + 눌러서 설명 보기
  const row = (it) => `
    <details class="mrow">
      <summary>
        <span class="mrow-label">${it.label}${it.lowConfidence ? ' <span class="badge low">신뢰도 낮음</span>' : ''}</span>
        <span class="mrow-value">${valueText(it)}</span>
        <span class="badge ${it.grade}">${gradeText[it.grade]}</span>
      </summary>
      <p class="mrow-desc">${it.detail ? `<b>${it.detail}</b> · ` : ''}${it.hint}</p>
    </details>`;
  const main = items.filter((it) => it.grade !== 'info').sort((x, y) => order[x.grade] - order[y.grade]);
  const ref = items.filter((it) => it.grade === 'info');
  const count = (g) => main.filter((it) => it.grade === g).length;
  const summary = [['warn', '주의'], ['ok', '보통'], ['good', '좋음']]
    .filter(([g]) => count(g)).map(([g, l]) => `<span class="badge ${g}">${l} ${count(g)}</span>`).join(' ');
  const timeNote = S.tb.resolvedType === 'slowed'
    ? `초 단위 시간은 슬로모션 배율(${fmt(1 / S.tb.timeScale, 1)}배)로 환산했어요. 가변 속도 구간이 섞이면 틀릴 수 있지만 템포 비율은 배율과 무관해요.`
    : '';
  const excluded = S.view === 'face'
    ? '척추 전경각은 정면 영상에서 측정할 수 없어 제외했어요.'
    : '머리 좌우 이동·스웨이는 후방 영상에서 측정할 수 없어 제외했어요(카메라 쪽 움직임은 화면에 드러나지 않아요).';
  const allNotes = [timeNote, excluded, ...notes].filter(Boolean);
  $('#result-body').innerHTML = `
    <div class="tempo-hero">
      <div class="big">템포 ${fmt(tempo.ratio, 1)} : 1 <span class="badge ${tempo.ratioGrade}">${gradeText[tempo.ratioGrade]}</span></div>
      <div class="sub">백스윙 ${fmt(tempo.backSec, 2)}초 · 다운스윙 ${fmt(tempo.downSec, 2)}초 · 투어 평균 약 3 : 1</div>
    </div>
    ${main.length ? `<div class="mrow-summary">${summary}<span class="hint-inline">항목을 누르면 설명이 보여요</span></div>${main.map(row).join('')}` : ''}
    ${ref.length ? `<details class="fold"><summary>참고 지표 ${ref.length}개</summary>${ref.map(row).join('')}</details>` : ''}
    <details class="fold"><summary>측정 방법·한계</summary><ul class="notes">${allNotes.map((n) => `<li>${n}</li>`).join('')}</ul></details>`;
}

async function makeSnapshots() {
  S.snapshotUrls.forEach((u) => URL.revokeObjectURL(u));
  S.snapshotUrls = [];
  S.snapshots = {};
  const box = $('#snapshots');
  box.innerHTML = '<p class="hint">스냅샷 만드는 중…</p>';
  const W = 320;
  const H = Math.round(W * (video.videoHeight / video.videoWidth));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const back = video.currentTime;
  for (const k of PHASES) {
    await seekTo(video, S.phases[k]);
    ctx.drawImage(video, 0, 0, W, H);
    drawSkeleton(ctx, landmarksAt(S.samples, S.phases[k]), W, H, { lineWidth: 2 });
    drawLines(ctx, W, H, { ...lineTool.toJSON(), visible: lineTool.state.visible }, currentAnchors());
    // eslint-disable-next-line no-await-in-loop
    S.snapshots[k] = await new Promise((r) => cv.toBlob((b) => r(b), 'image/jpeg', 0.72));
  }
  await seekTo(video, back);
  box.innerHTML = PHASES.map((k) => {
    const url = S.snapshots[k] ? URL.createObjectURL(S.snapshots[k]) : '';
    if (url) S.snapshotUrls.push(url);
    return `<figure>${url ? `<img src="${url}" alt="${PHASE_LABEL[k]} 스냅샷" />` : ''}<figcaption>${PHASE_LABEL[k]}</figcaption></figure>`;
  }).join('');
  draw();
}

$('#btn-save').addEventListener('click', async () => {
  if (!S.result) return;
  if (S.saved && S.savedRecord) {
    // 저장 후 실제 결과만 바뀐 경우: 같은 기록을 갱신
    try {
      S.savedRecord = { ...S.savedRecord, outcome: hasOutcome(S.outcome) ? { ...S.outcome } : null };
      await saveRecord(S.savedRecord);
      $('#btn-save').disabled = true;
      $('#btn-save').textContent = '저장됨';
      toast('실제 결과를 갱신했어요.');
    } catch (err) {
      toast(`저장하지 못했어요: ${err?.message || err}`, 5000);
    }
    return;
  }
  const id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    createdAt: Date.now(),
    appVersion: 1,
    fileName: S.file?.name || '',
    view: S.view,
    mode: S.mode,
    fileFps: S.fileFps,
    captureFps: S.mode === 'slowmo' ? S.captureFps : null,
    resolvedType: S.tb.resolvedType,
    heightCm: settings.heightCm,
    timeScale: S.tb.timeScale,
    trim: { ...S.trim },
    phases: { ...S.phases },
    editedPhases: { ...S.edited },
    tempo: S.result.tempo,
    items: S.result.items.map(({ key, label, value, unit, grade, detail, signed, lowConfidence, cm }) => ({ key, label, value, unit, grade, detail, signed: !!signed, lowConfidence: !!lowConfidence, cm: Number.isFinite(cm) ? cm : null })),
    notes: S.result.notes,
    snapshots: S.snapshots || {},
    guides: lineTool.toJSON(),
    features: featuresFrom(S.result),
    outcome: hasOutcome(S.outcome) ? { ...S.outcome } : null,
    diag: { ...S.analysisDiag, model: S.poseInfo?.model, delegate: S.poseInfo?.delegate, vfr: !!S.meta?.isVFR },
  };
  try {
    await saveRecord(record);
    S.saved = true;
    S.savedRecord = record;
    $('#btn-save').disabled = true;
    $('#btn-save').textContent = '저장됨';
    toast(hasOutcome(record.outcome) ? '기록과 실제 결과를 저장했어요.' : '기록에 저장했어요. 실제 결과는 기록 탭에서 나중에 입력할 수 있어요.', 3500);
  } catch (err) {
    toast(`저장하지 못했어요: ${err?.message || err}`, 5000);
  }
});

/* ---------------- 진단 ---------------- */
function renderDiag() {
  if (!S.file) return;
  const rows = [];
  const add = (k, v, warn = false) => rows.push(`<dt>${k}</dt><dd${warn ? ' class="warn"' : ''}>${v}</dd>`);
  add('파일', `${S.file.name} (${fmt(S.file.size / 1048576, 1)}MB, ${S.file.type || '형식 미상'})`);
  add('해상도', `${video.videoWidth}×${video.videoHeight}`);
  add('재생 길이', `${fmt(video.duration, 3)}초`);
  if (S.meta) {
    const m = S.meta;
    add('컨테이너 fps', `대표 ${fmt(m.modeFps, 3)} · 평균 ${fmt(m.avgFps, 3)} · 범위 ${fmt(m.minFps, 1)}~${fmt(m.maxFps, 1)}`);
    add('프레임 수 / 길이', `${m.sampleCount}개 / ${fmt(m.durationSec, 3)}초`);
    add('가변 프레임(VFR)', m.isVFR ? `예 (시간표 ${m.sttsEntries}개 구간)` : `아니오 (시간표 ${m.sttsEntries}개 구간)`, m.isVFR);
    if (m.editCount) add('편집 목록 재생 속도', m.editRates.join(', '), m.editRates.some((r) => r !== 1));
  } else {
    add('컨테이너 정보', 'MP4/MOV 정보를 읽지 못함', true);
  }
  if (S.playbackFps) add('재생 기반 추정 fps', `${fmt(S.playbackFps, 1)} (참고값)`);
  add('선택한 파일 fps', `${S.fileFps}`);
  add('시간 해석', `${S.tb.resolvedType} · 배율 ×${fmt(S.tb.timeScale, 4)} · 실제 초당 ${S.tb.effectiveFps}프레임`);
  add('실제 시간 환산 길이', `${fmt(toRealSeconds(S.duration, S.tb.timeScale), 3)}초`);
  const si = samplingInfo();
  add('샘플 간격', `영상 ${fmt(si.step * 1000, 1)}ms = 실제 ${fmt(si.realMs, 1)}ms (실제 ${fmt(si.realFps, 1)}fps)`);
  if (S.trim.start !== null && S.trim.end !== null) {
    add('트림', `영상 ${fmt(S.trim.start, 3)}~${fmt(S.trim.end, 3)}초 = 실제 ${fmt(toRealSeconds(S.trim.end - S.trim.start, S.tb.timeScale), 3)}초`);
  }
  if (S.poseInfo) add('자세 인식', `MediaPipe ${MEDIAPIPE_VERSION} · ${S.poseInfo.model} · ${S.poseInfo.delegate}`);
  if (S.analysisDiag) {
    const d = S.analysisDiag;
    add('분석 처리 속도', `${fmt(d.procFps, 1)}fps (${d.sampleCount}/${d.plannedCount}프레임, ${fmt(d.wallSec, 1)}초)`, d.procFps < 3);
    add('사람 인식률', `${Math.round(d.detectRate * 100)}%`, d.detectRate < 0.8);
    add('이동 타임아웃(500ms)', `${d.seekTimeouts}회`, d.seekTimeouts > 0);
    add('분석 해상도', d.analysisSize);
  }
  add('탐색 타임아웃(누적)', `${seekQueue.timeouts}회`, seekQueue.timeouts > 0);
  add('브라우저', navigator.userAgent.replace(/^Mozilla\/5\.0 /, ''));
  $('#diag-list').innerHTML = rows.join('');
}

/* ---------------- 기록 ---------------- */
let historyUrls = [];
async function renderHistory() {
  historyUrls.forEach((u) => URL.revokeObjectURL(u));
  historyUrls = [];
  const list = $('#history-list');
  let rows = [];
  try {
    rows = await listRecords();
  } catch (err) {
    list.innerHTML = `<p class="empty">${err?.message || '기록을 불러오지 못했어요.'}</p>`;
    return;
  }
  const est = await storageEstimate();
  $('#history-usage').textContent = `${rows.length}개 저장됨${est?.usage ? ` · 사용량 약 ${fmt(est.usage / 1048576, 1)}MB` : ''}`;
  $('#learn-status').innerHTML = learningStatusHTML(rows);
  if (!rows.length) { list.innerHTML = '<p class="empty">아직 저장한 기록이 없어요.</p>'; return; }
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  list.innerHTML = rows.map((r) => {
    const thumbs = PHASES.map((k) => {
      const b = r.snapshots?.[k];
      if (!b) return '<div></div>';
      const u = URL.createObjectURL(b);
      historyUrls.push(u);
      return `<img src="${u}" alt="${PHASE_LABEL[k]}" />`;
    }).join('');
    const d = new Date(r.createdAt);
    const when = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const stats = r.items.filter((i) => i.grade !== 'info')
      .map((i) => `${i.label} <b>${i.signed && i.value > 0 ? '+' : ''}${fmt(i.value, 1)}${i.unit}</b>${Number.isFinite(i.cm) ? ` (약 ${i.signed && i.cm > 0 ? '+' : ''}${fmt(i.cm, 1)}cm)` : ''}`).join('<br>');
    return `<div class="rec">
      <div class="rec-head"><b>템포 ${fmt(r.tempo.ratio, 1)} : 1</b><span>${when}</span></div>
      <div class="rec-stats">${r.view === 'face' ? '정면' : '후방'} · ${r.mode === 'slowmo' ? `슬로모션 ${r.captureFps || ''}` : '일반'} · 백스윙 ${fmt(r.tempo.backSec, 2)}초 / 다운스윙 ${fmt(r.tempo.downSec, 2)}초</div>
      <div class="rec-thumbs">${thumbs}</div>
      <div class="rec-stats">${stats}</div>
      <div class="rec-outcome">${hasOutcome(r.outcome) ? `🎯 ${outcomeSummary(r.outcome)}` : '<span class="muted-inline">실제 결과 미입력</span>'}</div>
      <div class="rec-form" data-form="${r.id}" hidden></div>
      <div class="rec-actions">
        <button type="button" class="btn btn-small" data-outcome="${r.id}">${hasOutcome(r.outcome) ? '결과 수정' : '결과 입력'}</button>
        <button type="button" class="btn btn-small" data-del="${r.id}">삭제</button>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-outcome]').forEach((b) => b.addEventListener('click', () => {
    const r = byId[b.dataset.outcome];
    const box = list.querySelector(`[data-form="${r.id}"]`);
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    let draft = r.outcome ? { ...r.outcome } : emptyOutcome(settings.lastClub);
    const formBox = document.createElement('div');
    box.innerHTML = '';
    box.append(formBox);
    mountOutcomeForm(formBox, draft, (o) => { draft = o; });
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary btn-block';
    save.textContent = '결과 저장';
    save.addEventListener('click', async () => {
      try {
        await saveRecord({ ...r, features: r.features || featuresFrom(r), outcome: hasOutcome(draft) ? draft : null });
        if (draft.club) { settings.lastClub = draft.club; saveSettings(); }
        toast('실제 결과를 저장했어요.');
        renderHistory();
      } catch (err) {
        toast(`저장하지 못했어요: ${err?.message || err}`, 5000);
      }
    });
    box.append(save);
  }));
  list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('이 기록을 삭제할까요?')) return;
    await deleteRecord(b.dataset.del);
    renderHistory();
  }));
}

/* ---------------- 설정 ---------------- */
setSeg('model', settings.model);
bindSeg('model', (v) => { settings.model = v; saveSettings(); toast(`자세 인식 모델: ${v === 'full' ? '정확' : '빠름'}`); });
$('#mp-version').textContent = `v${MEDIAPIPE_VERSION}`;

const heightInput = $('#height-input');
settings.heightCm = validHeight(settings.heightCm);
if (settings.heightCm) heightInput.value = String(settings.heightCm);
heightInput.addEventListener('change', () => {
  const raw = heightInput.value.trim();
  if (raw === '') {
    settings.heightCm = null;
    toast('키 입력을 지웠어요. 이동량은 %로만 보여줘요.');
  } else {
    const h = validHeight(raw);
    if (!h) {
      heightInput.value = settings.heightCm ? String(settings.heightCm) : '';
      toast('키는 100~230cm 사이로 입력해 주세요.');
      return;
    }
    settings.heightCm = h;
    heightInput.value = String(h);
    toast(`키 ${h}cm로 저장했어요.`);
  }
  saveSettings();
  // 이미 결과가 있으면 cm 환산을 다시 반영(저장 전 상태로 돌아감)
  if (S.result) buildResult();
});

/* ---------------- 비교 ---------------- */
initCompare({
  toast,
  // 분석 탭에서 확정한 영상을 비교 슬롯으로 가져오기
  getAnalysisSource: () => (S.file ? {
    file: S.file, fileFps: S.fileFps, mode: S.mode, captureFps: S.captureFps, fileType: S.fileType,
    impact: S.result ? S.phases?.impact ?? null : null, meta: S.meta,
  } : null),
  onEnter: () => { if (!video.paused) video.pause(); },
});

/* ---------------- 학습 모드 ---------------- */
let learnApi = null;
learnApi = initLearn({
  toast,
  getSettings: () => settings,
  saveSettings,
  openPanel: (name) => openTab(name),
});
$('#btn-learn-mode').addEventListener('click', () => {
  if (S.analyzing) { toast('일반 분석이 끝난 뒤에 학습 모드를 열어 주세요.'); return; }
  openTab('learn');
});

// 테스트·디버깅용으로 상태를 노출(동작에는 영향 없음)
window.__swing = { S, settings };
