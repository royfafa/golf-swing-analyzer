// 학습 모드: 여러 영상을 한 번에 넣고, 자동 트림·자동 구간 제안 후 사용자는 임팩트만 확인하고 실제 결과를 입력한다.
// - 뒤에서(숨긴 video) 다음 영상을 미리 분석하고, 앞에서(보이는 video) 현재 영상을 확인한다.
// - 저장할 때 그 시점의 추측을 함께 남겨 "추측 vs 실제"를 바로 보여준다.
// - 원본 영상은 저장하지 않는다(수치·실제 결과·4구간 스냅샷만).

import { COMMON_FPS, snapFps, computeTimeScale, samplingStep, frameCenter, toRealSeconds } from './timebase.js';
import { readVideoMeta } from './mp4meta.js';
import { seekTo, createSeekQueue, primeVideo } from './video.js';
import { loadPose } from './pose.js';
import { analyzeRange } from './analyze.js';
import { suggestPhases, phasesInOrder, autoTrimWindow, PHASES, PHASE_LABEL } from './phases.js';
import { computeMetrics, landmarksAt } from './metrics.js';
import { drawSkeleton, drawHandTrail, SEG_COLORS } from './render.js';
import { saveRecord, listRecords } from './store.js';
import { predictSwing, featuresFrom, CLUBS, CLUB_LABEL, START_LABEL, CURVE_LABEL } from './predict.js';
import { mountOutcomeForm, emptyOutcome, hasOutcome, withFeatures } from './outcome.js';

/** 자동 트림용 성긴 스캔: 실제 10fps, 최대 150프레임 */
const SCAN_REAL_FPS = 10;
const SCAN_MAX = 150;

const $ = (s, root = document) => root.querySelector(s);
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STATUS_TEXT = {
  queued: '대기', scanning: '스윙 구간 찾는 중', analyzing: '자세 분석 중', ready: '확인 대기',
  saved: '저장됨', skipped: '건너뜀', failed: '실패',
};

/**
 * @param {{toast:Function, getSettings:()=>object, saveSettings:()=>void, openPanel:(name:string)=>void}} deps
 */
export function initLearn({ toast, getSettings, saveSettings, openPanel }) {
  const panel = $('#panel-learn');
  const workerVideo = $('#learn-worker-video');
  const video = $('#learn-video');
  const overlay = $('#learn-overlay');
  const seekQ = createSeekQueue(video, () => { renderTime(); draw(); });

  const session = { view: null, mode: 'normal', captureFps: 240, fileType: 'auto', defaultFps: 60, club: getSettings().lastClub || null };
  /** @type {Array<object>} */
  const items = [];
  let current = null;     // 확인 중인 항목
  let running = false;    // 뒤쪽 분석 루프 동작 중
  let stopFlag = false;
  let activePhase = 'impact';
  let poseInfo = null;

  /* ---------- 세션 설정 ---------- */
  const segs = panel.querySelectorAll('.seg[data-l]');
  segs.forEach((sg) => sg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    if (lockedSettings() && sg.dataset.l !== 'club') { toast('분석이 시작된 뒤에는 세션 설정을 바꿀 수 없어요. 학습을 끝내고 새로 시작해 주세요.'); return; }
    session[sg.dataset.l] = b.dataset.value;
    renderSetup();
  })));
  $('#learn-capture').addEventListener('change', (e) => { session.captureFps = Number(e.target.value); });
  $('#learn-default-fps').innerHTML = COMMON_FPS.filter((f) => f >= 24 && f <= 240)
    .map((f) => `<option value="${f}" ${f === 60 ? 'selected' : ''}>${f} fps</option>`).join('');
  $('#learn-default-fps').addEventListener('change', (e) => { session.defaultFps = Number(e.target.value); });
  $('#learn-club').innerHTML = `<option value="">선택 안 함</option>${CLUBS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}`;
  $('#learn-club').value = session.club || '';
  $('#learn-club').addEventListener('change', (e) => { session.club = e.target.value || null; });

  const lockedSettings = () => items.some((it) => it.status !== 'queued');

  function renderSetup() {
    panel.querySelectorAll('.seg[data-l]').forEach((sg) => {
      sg.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', session[sg.dataset.l] === b.dataset.value));
    });
    $('#learn-slowmo').hidden = session.mode !== 'slowmo';
    $('#learn-view-seg').classList.toggle('needs-choice', !session.view);
    // 세션이 시작되면 설정을 한 줄 요약으로 접는다
    const locked = lockedSettings();
    $('#learn-setup-fields').hidden = locked;
    $('#learn-intro').hidden = locked;
    $('#learn-summary').hidden = !locked;
    if (locked) {
      const mode = session.mode === 'slowmo' ? `슬로모션 ${session.captureFps}fps` : '일반';
      $('#learn-summary').textContent = `세션: ${session.view === 'face' ? '정면' : '후방'} · ${mode} · 기본 클럽 ${session.club ? CLUB_LABEL[session.club] : '없음'}`;
    }
  }

  $('#learn-files').addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    if (!session.view) { toast('촬영 방향을 먼저 선택해 주세요.'); return; }
    for (const f of files) {
      items.push({ id: `${Date.now().toString(36)}-${items.length}`, file: f, status: 'queued', progress: 0 });
    }
    toast(`영상 ${files.length}개를 추가했어요. 자동으로 분석을 시작해요.`);
    show('#learn-queue');
    renderQueue();
    runWorker();
    renderSetup();
  });

  $('#learn-exit').addEventListener('click', () => openPanel('analyze'));
  $('#learn-stop').addEventListener('click', () => {
    const left = items.filter((it) => ['queued', 'scanning', 'analyzing', 'ready'].includes(it.status)).length;
    if (left && !confirm(`아직 확인하지 않은 영상 ${left}개가 있어요. 학습을 끝낼까요? (저장한 기록은 남아요)`)) return;
    stopFlag = true;
    const saved = items.filter((it) => it.status === 'saved').length;
    toast(`학습을 끝냈어요. 이번에 저장한 기록 ${saved}개.`, 3500);
    for (const it of items) if (it.url) URL.revokeObjectURL(it.url);
    items.length = 0;
    current = null;
    video.removeAttribute('src');
    show('#learn-review', false);
    show('#learn-queue', false);
    renderSetup();
    // 뒤쪽 분석이 멈춘 뒤에 해제(runWorker의 finally에서)
    if (!running) stopFlag = false;
  });

  /* ---------- 뒤쪽 분석 루프 ---------- */
  function waitMeta(v, ms = 10000) {
    return new Promise((resolve, reject) => {
      const done = (fn, a) => { clearTimeout(tm); v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', bad); fn(a); };
      const ok = () => done(resolve);
      const bad = () => done(reject, new Error('이 영상 형식을 열 수 없어요'));
      const tm = setTimeout(() => done(reject, new Error('영상을 여는 데 시간이 너무 걸려요')), ms);
      v.addEventListener('loadedmetadata', ok);
      v.addEventListener('error', bad);
    });
  }

  async function runWorker() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        if (stopFlag) break;
        const it = items.find((x) => x.status === 'queued');
        if (!it) break;
        await processItem(it);
        renderQueue();
        if (!current && it.status === 'ready') openItem(it);
      }
    } finally {
      running = false;
      if (stopFlag) {
        stopFlag = false;
        // 멈추는 사이에 새로 추가된 영상이 있으면 이어서 처리
        if (items.some((x) => x.status === 'queued')) setTimeout(runWorker, 0);
      }
      renderQueue();
    }
  }

  async function processItem(it) {
    try {
      it.status = 'scanning';
      renderQueue();
      it.url = URL.createObjectURL(it.file);
      workerVideo.src = it.url;
      await waitMeta(workerVideo);
      it.width = workerVideo.videoWidth;
      it.height = workerVideo.videoHeight;
      it.aspect = it.width / it.height;
      it.meta = await readVideoMeta(it.file);
      it.duration = Number.isFinite(workerVideo.duration) && workerVideo.duration > 0 ? workerVideo.duration : (it.meta?.durationSec || 0);
      it.fileFps = it.meta ? snapFps(it.meta.modeFps) : session.defaultFps;
      it.fpsSource = it.meta ? '파일 정보' : '세션 기본값';
      it.tb = computeTimeScale({ mode: session.mode, fileFps: it.fileFps, captureFps: session.captureFps, fileType: session.fileType });
      await primeVideo(workerVideo);
      poseInfo = await loadPose(getSettings().model);

      // 1) 성긴 스캔으로 자동 트림
      let step = samplingStep({ fileFps: it.fileFps, timeScale: it.tb.timeScale, maxRealFps: SCAN_REAL_FPS });
      if (it.duration / step > SCAN_MAX) step = it.duration / SCAN_MAX;
      const scan = await analyzeRange(workerVideo, {
        start: 0, end: it.duration - 1e-3, step, timeScale: it.tb.timeScale,
        shouldAbort: () => stopFlag,
        onProgress: ({ done, total }) => { it.progress = (done / total) * 0.4; renderItemProgress(it); },
      });
      if (scan.aborted) return;
      const win = autoTrimWindow(scan.samples, { aspect: it.aspect, timeScale: it.tb.timeScale, duration: it.duration });
      if (!win) throw new Error('사람 또는 스윙을 찾지 못했어요');
      it.trim = { start: frameCenter(win.start, it.fileFps), end: frameCenter(win.end, it.fileFps) };
      it.trimMethod = win.method;

      // 2) 트림 구간을 실제 30fps 간격으로 정밀 분석
      it.status = 'analyzing';
      renderQueue();
      const fine = await analyzeRange(workerVideo, {
        start: it.trim.start, end: it.trim.end,
        step: samplingStep({ fileFps: it.fileFps, timeScale: it.tb.timeScale }),
        timeScale: it.tb.timeScale,
        shouldAbort: () => stopFlag,
        onProgress: ({ done, total }) => { it.progress = 0.4 + (done / total) * 0.6; renderItemProgress(it); },
      });
      if (fine.aborted) return;
      it.samples = fine.samples;
      it.diag = { scan: scan.diag, fine: fine.diag };
      if (fine.diag.detectRate < 0.5) throw new Error(`사람 인식률이 낮아요(${Math.round(fine.diag.detectRate * 100)}%)`);

      // 3) 4구간 제안(실패 시 임팩트 추정값 기준 임시값 + 경고)
      const sug = suggestPhases(it.samples, { aspect: it.aspect, timeScale: it.tb.timeScale });
      it.warnings = [...sug.warnings];
      if (win.method === 'peakSpeed') it.warnings.unshift('스윙 구간을 손 속도로만 찾았어요. 트림이 맞는지 확인해 주세요.');
      if (sug.times) {
        it.suggested = { ...sug.times };
      } else {
        const ts = it.tb.timeScale;
        const imp = frameCenter(Math.min(Math.max(win.impactGuess, it.trim.start + 0.5 / ts), it.trim.end - 0.3 / ts), it.fileFps);
        const clamp = (t) => frameCenter(Math.min(it.trim.end, Math.max(it.trim.start, t)), it.fileFps);
        it.suggested = { address: clamp(imp - 1.1 / ts), top: clamp(imp - 0.3 / ts), impact: imp, finish: clamp(imp + 0.8 / ts) };
        it.lowConfidence = true;
      }
      if (it.warnings.length) it.lowConfidence = true;
      it.phases = { ...it.suggested };
      it.edited = {};
      it.outcome = emptyOutcome(session.club);
      it.status = 'ready';
    } catch (err) {
      it.status = 'failed';
      it.error = String(err?.message || err);
    } finally {
      workerVideo.removeAttribute('src');
      workerVideo.load();
    }
  }

  /* ---------- 진행 목록 ---------- */
  function renderItemProgress(it) {
    const el = panel.querySelector(`[data-item="${it.id}"] .q-status`);
    if (el) el.textContent = `${STATUS_TEXT[it.status]} ${Math.round(it.progress * 100)}%`;
  }

  function renderQueue() {
    const done = items.filter((it) => ['saved', 'skipped', 'failed'].includes(it.status)).length;
    $('#learn-count').textContent = `${done}/${items.length}`;
    $('#learn-fill').style.width = `${items.length ? (done / items.length) * 100 : 0}%`;
    $('#learn-list').innerHTML = items.map((it, i) => {
      let status = STATUS_TEXT[it.status];
      if (it.status === 'scanning' || it.status === 'analyzing') status += ` ${Math.round(it.progress * 100)}%`;
      if (it.status === 'failed') status += `: ${it.error}`;
      if (it.status === 'saved') status += ` · ${it.resultText}`;
      if (it.status === 'ready' && it.lowConfidence) status += ' · ⚠ 확인 필요';
      const cls = `q-item q-${it.status}${current === it ? ' is-current' : ''}`;
      const clickable = ['ready', 'saved', 'skipped'].includes(it.status);
      return `<li class="${cls}" data-item="${it.id}" ${clickable ? 'role="button" tabindex="0"' : ''}>
        <span class="q-num">${i + 1}</span>
        <span class="q-body"><span class="q-name">${esc(it.file.name)}</span><span class="q-status">${status}</span></span>
      </li>`;
    }).join('');
    $('#learn-list').querySelectorAll('[role="button"]').forEach((li) => li.addEventListener('click', () => {
      const it = items.find((x) => x.id === li.dataset.item);
      if (it) openItem(it);
    }));
    $('#learn-open-btn-count').textContent = items.length ? ` (${done}/${items.length})` : '';
  }

  /* ---------- 확인 화면 ---------- */
  async function openItem(it) {
    // 저장된 항목도 다시 열어 실제 결과를 고칠 수 있다
    current = it;
    activePhase = 'impact';
    video.pause();
    video.src = it.url;
    try { await waitMeta(video); } catch (err) { toast(err.message); return; }
    const stage = $('#learn-stage');
    stage.style.setProperty('--ar', `${it.width} / ${it.height}`);
    stage.style.setProperty('--ar-num', String(it.aspect));
    show('#learn-review');
    $('#learn-review-title').textContent = `${items.indexOf(it) + 1}번 · ${it.file.name}`;
    await primeVideo(video);
    await seekTo(video, it.phases.impact);
    $('#learn-phases').open = !!it.lowConfidence;
    renderReview();
    const form = $('#learn-outcome');
    mountOutcomeForm(form, it.outcome, (o) => {
      it.outcome = o;
      if (o.club) { session.club = o.club; getSettings().lastClub = o.club; saveSettings(); }
    });
    renderQueue();
    $('#learn-review').scrollIntoView({ behavior: 'smooth', block: 'start' });
    draw();
  }

  function renderReview() {
    const it = current;
    if (!it) return;
    $('#learn-impact-time').textContent = `${fmt(it.phases.impact, 3)}초${it.edited.impact ? ' (수정됨)' : ' (자동)'}`;
    $('#learn-warnings').innerHTML = (it.warnings || []).map((w) => `<li>${esc(w)}</li>`).join('');
    $('#learn-chips').innerHTML = PHASES.map((k) => `
      <button type="button" class="phase-chip ${k === activePhase ? 'is-active' : ''} ${it.edited[k] ? 'is-edited' : ''}" data-phase="${k}">
        <b>${PHASE_LABEL[k]}</b>${fmt(it.phases[k], 3)}초
      </button>`).join('');
    $('#learn-chips').querySelectorAll('.phase-chip').forEach((b) => b.addEventListener('click', () => {
      activePhase = b.dataset.phase;
      renderReview();
      stepTo(it.phases[activePhase]);
    }));
    $('#learn-set-phase').textContent = `현재 프레임을 ${PHASE_LABEL[activePhase]}(으)로`;
    const m = currentMetrics();
    $('#learn-metrics').innerHTML = m
      ? `<span>템포 <b>${fmt(m.tempo.ratio, 1)}:1</b></span>${m.items.filter((x) => ['handSpeed', 'handPathDown', 'headLateral', 'spineImpactChange', 'hipSwayBack'].includes(x.key))
        .map((x) => `<span>${esc(x.label.replace(/ \(.+\)$/, ''))} <b>${x.signed && x.value > 0 ? '+' : ''}${fmt(x.value, 1)}${x.unit === '신장/초' ? '' : x.unit}</b></span>`).join('')}`
      : '<span>구간 순서를 확인해 주세요.</span>';
    $('#learn-save').textContent = it.status === 'saved' ? '결과 변경 저장' : '저장 후 다음 ▶';
    $('#learn-skip').hidden = it.status === 'saved';
  }

  function currentMetrics() {
    const it = current;
    if (!it || !phasesInOrder(it.phases)) return null;
    return computeMetrics(it.samples, it.phases, {
      view: session.view, aspect: it.aspect, timeScale: it.tb.timeScale, heightCm: getSettings().heightCm,
    });
  }

  function stepTo(t) {
    if (!current) return;
    if (!video.paused) video.pause();
    seekQ.request(frameCenter(Math.max(0, Math.min(current.duration - 1e-3, t)), current.fileFps));
  }
  const frameStep = (dir) => current && stepTo(frameCenter(video.currentTime, current.fileFps) + dir / current.fileFps);
  const sampleStep = (dir) => {
    if (!current) return;
    const t = video.currentTime;
    const s = dir > 0 ? current.samples.find((x) => x.t > t + 1e-4) : [...current.samples].reverse().find((x) => x.t < t - 1e-4);
    if (s) stepTo(s.t);
  };
  $('#learn-prev-sample').addEventListener('click', () => sampleStep(-1));
  $('#learn-prev-frame').addEventListener('click', () => frameStep(-1));
  $('#learn-next-frame').addEventListener('click', () => frameStep(1));
  $('#learn-next-sample').addEventListener('click', () => sampleStep(1));
  $('#learn-to-impact').addEventListener('click', () => current && stepTo(current.phases.impact));
  $('#learn-play').addEventListener('click', async () => {
    if (!current) return;
    if (!video.paused) { video.pause(); return; }
    const { start, end } = current.trim;
    if (video.currentTime < start || video.currentTime >= end - 0.01) await seekTo(video, start);
    video.playbackRate = Math.min(4, Math.max(0.0625, 0.25 / current.tb.timeScale));
    video.play().catch(() => toast('재생을 시작하지 못했어요.'));
  });
  video.addEventListener('play', () => { $('#learn-play').textContent = '⏸'; loop(); });
  video.addEventListener('pause', () => { $('#learn-play').textContent = '▶︎'; renderTime(); draw(); });
  function loop() {
    if (video.paused || !current) return;
    if (video.currentTime >= current.trim.end) video.currentTime = current.trim.start;
    renderTime();
    draw();
    requestAnimationFrame(loop);
  }

  function setPhase(k) {
    const it = current;
    const t = frameCenter(video.currentTime, it.fileFps);
    const first = it.samples[0].t, last = it.samples[it.samples.length - 1].t;
    if (t < first - 1e-3 || t > last + 1e-3) { toast('자동으로 자른 구간 밖이에요. 구간 안에서 지정해 주세요.'); return; }
    const next = { ...it.phases, [k]: t };
    if (!phasesInOrder(next)) { toast('순서가 맞지 않아요: 어드레스 < 탑 < 임팩트 < 피니시. 4구간을 펼쳐 함께 조정해 주세요.', 3500); $('#learn-phases').open = true; return; }
    it.phases = next;
    it.edited[k] = true;
    renderReview();
    draw();
  }
  $('#learn-set-impact').addEventListener('click', () => current && setPhase('impact'));
  $('#learn-set-phase').addEventListener('click', () => current && setPhase(activePhase));
  $('#learn-reset-phases').addEventListener('click', () => {
    if (!current) return;
    current.phases = { ...current.suggested };
    current.edited = {};
    renderReview();
    stepTo(current.phases[activePhase]);
  });

  $('#learn-skip').addEventListener('click', () => {
    if (!current) return;
    current.status = 'skipped';
    goNext();
  });

  $('#learn-save').addEventListener('click', async () => {
    const it = current;
    if (!it) return;
    if (!phasesInOrder(it.phases)) { toast('구간 순서를 확인해 주세요.'); return; }
    const btn = $('#learn-save');
    btn.disabled = true;
    try {
      const result = currentMetrics();
      const features = featuresFrom(result);
      if (it.status === 'saved' && it.savedRecord) {
        it.savedRecord = { ...it.savedRecord, outcome: hasOutcome(it.outcome) ? { ...it.outcome } : null };
        await saveRecord(it.savedRecord);
        it.resultText = resultText(it);
        toast('실제 결과를 갱신했어요.');
        renderQueue();
        return;
      }
      // 저장 직전 추측(이 기록은 아직 없으므로 자연스럽게 제외됨)
      let pred = null;
      try {
        pred = predictSwing(withFeatures(await listRecords()), features, { view: session.view, club: it.outcome?.club || null });
      } catch { /* 저장소를 못 열면 추측 없이 저장 */ }
      it.prediction = pred ? {
        distance: Number.isFinite(pred.distance?.value) ? pred.distance.value : null,
        start: Number.isFinite(pred.start?.value) ? pred.start.value : null,
        curve: Number.isFinite(pred.curve?.value) ? pred.curve.value : null,
      } : null;
      const snapshots = await makeSnapshots(it);
      const record = {
        id: (crypto.randomUUID && crypto.randomUUID()) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        appVersion: 1,
        source: 'learn',
        fileName: it.file.name,
        view: session.view,
        mode: session.mode,
        fileFps: it.fileFps,
        captureFps: session.mode === 'slowmo' ? session.captureFps : null,
        resolvedType: it.tb.resolvedType,
        heightCm: getSettings().heightCm,
        timeScale: it.tb.timeScale,
        trim: { ...it.trim },
        autoTrim: it.trimMethod,
        phases: { ...it.phases },
        editedPhases: { ...it.edited },
        lowConfidence: !!it.lowConfidence,
        tempo: result.tempo,
        items: result.items.map(({ key, label, value, unit, grade, detail, signed, lowConfidence, cm }) => ({
          key, label, value, unit, grade, detail, signed: !!signed, lowConfidence: !!lowConfidence, cm: Number.isFinite(cm) ? cm : null,
        })),
        notes: result.notes,
        snapshots,
        guides: null,
        features,
        outcome: hasOutcome(it.outcome) ? { ...it.outcome } : null,
        predictionAtSave: it.prediction,
        diag: {
          ...it.diag?.fine, scanSamples: it.diag?.scan?.sampleCount, fpsSource: it.fpsSource,
          model: poseInfo?.model, delegate: poseInfo?.delegate, vfr: !!it.meta?.isVFR,
        },
      };
      await saveRecord(record);
      it.savedRecord = record;
      it.status = 'saved';
      it.resultText = resultText(it);
      toast(it.prediction && hasOutcome(it.outcome) ? `저장했어요 · ${compareText(it)}` : '저장했어요.', 3500);
      goNext();
    } catch (err) {
      toast(`저장하지 못했어요: ${err?.message || err}`, 5000);
    } finally {
      btn.disabled = false;
    }
  });

  function resultText(it) {
    const o = it.outcome;
    const parts = [];
    if (o?.club) parts.push(CLUB_LABEL[o.club]);
    if (Number.isFinite(o?.distance)) parts.push(`${Math.round(o.distance)}m`);
    if (Number.isFinite(o?.curve)) parts.push(CURVE_LABEL[o.curve]);
    if (!parts.length) parts.push('결과 미입력');
    const cmp = compareText(it);
    return cmp ? `${parts.join(' ')} (${cmp})` : parts.join(' ');
  }
  /** 추측 vs 실제 */
  function compareText(it) {
    const p = it.prediction, o = it.outcome;
    if (!p || !o) return '';
    const parts = [];
    if (Number.isFinite(p.distance) && Number.isFinite(o.distance)) parts.push(`추측 ${Math.round(p.distance)}m → 실제 ${Math.round(o.distance)}m`);
    if (Number.isFinite(p.curve) && Number.isFinite(o.curve)) parts.push(`휘어짐 ${p.curve === o.curve ? '적중' : `추측 ${CURVE_LABEL[p.curve]}`}`);
    else if (Number.isFinite(p.start) && Number.isFinite(o.start)) parts.push(`출발 ${p.start === o.start ? '적중' : `추측 ${START_LABEL[p.start]}`}`);
    return parts.join(', ');
  }

  async function goNext() {
    video.pause();
    const prev = current;
    current = null;
    renderQueue();
    const idx = items.indexOf(prev);
    const next = items.slice(idx + 1).find((x) => x.status === 'ready') || items.find((x) => x.status === 'ready');
    if (next) { openItem(next); return; }
    if (items.some((x) => ['queued', 'scanning', 'analyzing'].includes(x.status))) {
      show('#learn-review', false);
      toast('다음 영상을 분석 중이에요. 끝나면 자동으로 열려요.');
      return;
    }
    show('#learn-review', false);
    const saved = items.filter((x) => x.status === 'saved').length;
    toast(`모든 영상을 확인했어요. 저장 ${saved}개. "+ 영상 추가"로 계속하거나 학습을 끝내세요.`, 4500);
  }

  async function makeSnapshots(it) {
    const W = 320;
    const H = Math.round(W * (it.height / it.width));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const out = {};
    for (const k of PHASES) {
      await seekTo(video, it.phases[k]);
      ctx.drawImage(video, 0, 0, W, H);
      drawSkeleton(ctx, landmarksAt(it.samples, it.phases[k]), W, H, { lineWidth: 2 });
      out[k] = await new Promise((r) => cv.toBlob((b) => r(b), 'image/jpeg', 0.72));
    }
    return out;
  }

  /* ---------- 그리기 ---------- */
  function renderTime() {
    if (!current) return;
    const t = video.currentTime;
    $('#learn-timecode').textContent =
      `영상 ${fmt(t, 3)}초 · 실제 ${fmt(toRealSeconds(t, current.tb.timeScale), 3)}초 · 프레임 ${Math.floor(t * current.fileFps + 1e-6)} · 임팩트까지 ${fmt((current.phases.impact - t) * current.tb.timeScale * 1000, 0)}ms`;
  }
  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(overlay.clientWidth * dpr), h = Math.round(overlay.clientHeight * dpr);
    if (!w || !h) return;
    if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const it = current;
    if (!it?.samples?.length) return;
    const t = video.currentTime;
    const lw = Math.max(2, w / 180);
    drawHandTrail(ctx, it.samples, t, it.phases, w, h, lw);
    drawSkeleton(ctx, landmarksAt(it.samples, t), w, h, { lineWidth: lw });
    // 임팩트 프레임이면 테두리 표시
    if (Math.abs(t - it.phases.impact) < 0.5 / it.fileFps) {
      ctx.strokeStyle = SEG_COLORS.down;
      ctx.lineWidth = lw * 2;
      ctx.strokeRect(lw, lw, w - lw * 2, h - lw * 2);
    }
  }
  new ResizeObserver(() => draw()).observe(overlay);

  const show = (sel, on = true) => { $(sel).hidden = !on; };

  // 다른 화면으로 가면 확인용 영상만 멈춘다(뒤쪽 분석은 계속)
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => video.pause()));

  renderSetup();
  return {
    /** 뒤쪽에서 자세 분석이 돌고 있는지(일반 분석과 동시 실행 방지) */
    get busy() { return running; },
  };
}
