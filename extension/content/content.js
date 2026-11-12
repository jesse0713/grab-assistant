/*
 * 抢单助手 - 内容脚本
 * 负责两件事：
 *  1. 录制模式：在页面上显示悬浮工具条，把用户点击的元素转成可回放的步骤。
 *  2. 执行模式：在目标时间点击元素；遇到验证码、支付按钮立即停手。
 */
(function () {
  'use strict';

  if (window.__GRAB_ASSISTANT_CONTENT__) return;
  window.__GRAB_ASSISTANT_CONTENT__ = true;

  const U = globalThis.GrabUtils;
  if (!U) return;

  const HOST_ID = 'grab-assistant-host';
  const CLICKABLE_SELECTOR =
    'button,a,input,select,textarea,label,summary,[role="button"],[onclick],[tabindex]';

  let recording = false;
  let recordInputs = false;
  let recordingCount = 0;
  let suppressClick = false;
  let overlay = null;
  let lastHover = null;
  let rafPending = false;
  let toastTimer = null;
  let arm = null;
  let armTimer = null;
  let keepAliveTimer = null;
  let handshakeTimer = null;
  let handshakeAttempts = 0;

  /* ------------------------------------------------------------------ *
   * 消息
   * ------------------------------------------------------------------ */

  function send(message, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, error: '扩展后台响应超时' }), timeoutMs || 4000);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            finish({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            finish(response || { ok: true });
          }
        });
      } catch (err) {
        clearTimeout(timer);
        finish({ ok: false, error: err && err.message ? err.message : '扩展已重新加载，请刷新页面' });
      }
    });
  }

  function notify(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        // 读取 lastError，避免控制台报未处理的错误
        void chrome.runtime.lastError;
      });
    } catch (err) {
      /* 扩展上下文失效时忽略 */
    }
  }

  /* ------------------------------------------------------------------ *
   * 悬浮层
   * ------------------------------------------------------------------ */

  function ensureOverlay() {
    if (overlay && overlay.host && overlay.host.isConnected) return overlay;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .bar {
          position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
          display: flex; align-items: center; gap: 8px;
          max-width: 94vw; padding: 9px 10px 9px 13px;
          background: #16181d; color: #fff;
          border: 1px solid rgba(255,255,255,.12);
          border-radius: 14px;
          box-shadow: 0 12px 40px rgba(0,0,0,.35), 0 2px 8px rgba(0,0,0,.2);
          font: 13px/1.2 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
          pointer-events: auto; user-select: none; white-space: nowrap;
        }
        .dot {
          width: 8px; height: 8px; border-radius: 50%; background: #ff4d4f;
          box-shadow: 0 0 0 4px rgba(255,77,79,.16);
          animation: pulse 1.4s ease-in-out infinite;
        }
        @keyframes pulse { 50% { opacity: .45; } }
        .title { font-weight: 650; letter-spacing: .02em; }
        .count {
          color: #ffb199; background: rgba(255,90,31,.16);
          border-radius: 999px; padding: 3px 8px; font-size: 12px; font-weight: 600;
        }
        button {
          appearance: none; border: 0; cursor: pointer;
          font: inherit; color: inherit; background: transparent;
          padding: 6px 9px; border-radius: 8px; line-height: 1;
        }
        button:hover { background: rgba(255,255,255,.09); }
        button.active { background: rgba(255,90,31,.2); color: #ffb199; }
        .done { background: #ff5a1f; color: #fff; font-weight: 650; }
        .done:hover { background: #ff6f3c; }
        .cancel { color: #aeb3bd; }
        .tip {
          position: fixed; left: 50%; bottom: 66px; transform: translateX(-50%);
          max-width: 92vw; padding: 7px 11px;
          background: rgba(22,24,29,.88); color: #d7dae0;
          border-radius: 9px; font: 12px/1.4 system-ui, "Microsoft YaHei", sans-serif;
          pointer-events: none; white-space: nowrap;
        }
        .highlight {
          position: fixed; display: none; pointer-events: none;
          border: 2px solid #ff5a1f; background: rgba(255,90,31,.10);
          border-radius: 6px; box-shadow: 0 0 0 1px rgba(255,255,255,.35) inset;
        }
        .label {
          position: fixed; display: none; pointer-events: none;
          max-width: 320px; padding: 4px 8px; border-radius: 6px;
          background: #ff5a1f; color: #fff;
          font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .toast {
          position: fixed; left: 50%; bottom: 118px; transform: translate(-50%, 8px);
          max-width: 92vw; padding: 8px 12px; border-radius: 9px;
          background: #0f7b4f; color: #fff; font: 12px/1.4 system-ui, "Microsoft YaHei", sans-serif;
          opacity: 0; pointer-events: none; transition: opacity .16s, transform .16s;
          white-space: nowrap;
        }
        .toast.show { opacity: 1; transform: translate(-50%, 0); }
        .toast.error { background: #b42318; }
      </style>
      <div class="tip" part="tip">点击页面元素记录步骤 · 提交/支付会被拦截</div>
      <div class="bar">
        <span class="dot"></span>
        <span class="title">录制中</span>
        <span class="count">0 步</span>
        <button data-act="inputs" title="记录输入框里的内容，仅保存在本机">记录输入</button>
        <button data-act="done" class="done">完成</button>
        <button data-act="cancel" class="cancel">取消</button>
      </div>
      <div class="highlight"></div>
      <div class="label"></div>
      <div class="toast"></div>
    `;

    const bar = shadow.querySelector('.bar');
    const count = shadow.querySelector('.count');
    const inputsBtn = shadow.querySelector('[data-act="inputs"]');
    const highlight = shadow.querySelector('.highlight');
    const label = shadow.querySelector('.label');
    const toast = shadow.querySelector('.toast');

    inputsBtn.addEventListener('click', () => {
      recordInputs = !recordInputs;
      inputsBtn.classList.toggle('active', recordInputs);
      notify({ type: 'SET_RECORD_INPUTS', value: recordInputs });
      showToast(recordInputs ? '会记录输入内容，仅保存在本机' : '不再记录输入内容');
    });
    shadow.querySelector('[data-act="done"]').addEventListener('click', finishRecording);
    shadow.querySelector('[data-act="cancel"]').addEventListener('click', cancelRecording);

    document.documentElement.appendChild(host);

    overlay = { host, shadow, bar, count, inputsBtn, highlight, label, toast };
    updateOverlay();
    return overlay;
  }

  function updateOverlay() {
    if (!overlay) return;
    overlay.count.textContent = `${recordingCount} 步`;
    overlay.inputsBtn.classList.toggle('active', recordInputs);
    overlay.inputsBtn.title = recordInputs ? '正在记录输入内容' : '记录输入框里的内容，仅保存在本机';
  }

  function showOverlay() {
    const ui = ensureOverlay();
    ui.bar.style.display = 'flex';
    ui.shadow.querySelector('.tip').style.display = 'block';
  }

  function hideOverlay() {
    if (!overlay) return;
    overlay.highlight.style.display = 'none';
    overlay.label.style.display = 'none';
    if (overlay.host && overlay.host.isConnected) overlay.host.remove();
    overlay = null;
    lastHover = null;
  }

  function showToast(text, isError) {
    if (!overlay) return;
    const node = overlay.toast;
    node.textContent = text;
    node.classList.toggle('error', !!isError);
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2200);
  }

  function drawHighlight(el) {
    if (!overlay || !recording) return;
    if (!el || !el.isConnected) {
      overlay.highlight.style.display = 'none';
      overlay.label.style.display = 'none';
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      overlay.highlight.style.display = 'none';
      overlay.label.style.display = 'none';
      return;
    }
    const box = overlay.highlight;
    box.style.display = 'block';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;

    const label = overlay.label;
    const name = U.accessibleName(el) || el.tagName.toLowerCase();
    label.textContent = `${el.tagName.toLowerCase()} · ${name}`.slice(0, 70);
    label.style.display = 'block';
    const labelTop = rect.top > 28 ? rect.top - 24 : rect.bottom + 6;
    label.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 260))}px`;
    label.style.top = `${labelTop}px`;
  }

  function pickElement(raw) {
    if (!raw || raw.nodeType !== 1) return null;
    if (raw === document.documentElement || raw === document.body) return null;
    const clickable = raw.closest ? raw.closest(CLICKABLE_SELECTOR) : null;
    return clickable || raw;
  }

  function onMouseMove(event) {
    if (!recording) return;
    if (overlay && event.composedPath && event.composedPath().includes(overlay.host)) {
      if (overlay) {
        overlay.highlight.style.display = 'none';
        overlay.label.style.display = 'none';
      }
      return;
    }
    const el = pickElement(event.target);
    lastHover = el;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      drawHighlight(lastHover);
    });
  }

  function onScroll() {
    if (!recording || !lastHover) return;
    drawHighlight(lastHover);
  }

  /* ------------------------------------------------------------------ *
   * 录制
   * ------------------------------------------------------------------ */

  function startRecording(options) {
    const opts = options || {};
    recording = true;
    recordingCount = Number.isFinite(Number(opts.count)) ? Number(opts.count) : recordingCount;
    if (typeof opts.recordInputs === 'boolean') recordInputs = opts.recordInputs;
    showOverlay();
    updateOverlay();
    showToast('录制已开始：点击页面元素即可记录');
  }

  function stopRecordingLocal() {
    recording = false;
    hideOverlay();
  }

  async function finishRecording() {
    if (!recording) return;
    recording = false;
    hideOverlay();
    const result = await send({ type: 'STOP_RECORDING' }, 8000);
    if (!result.ok) {
      // 保存失败时把录制状态还给用户，避免步骤丢失
      recording = true;
      showOverlay();
      showToast(result.error || '保存失败，请重试', true);
      return;
    }
    recordingCount = result.count || recordingCount;
    // 保存完成后显示一个短暂的确认提示
    const toastHost = document.createElement('div');
    toastHost.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;' +
      'padding:10px 14px;border-radius:10px;background:#0f7b4f;color:#fff;' +
      'font:13px system-ui,"Microsoft YaHei";box-shadow:0 8px 30px rgba(0,0,0,.25)';
    toastHost.textContent = `已保存 ${recordingCount} 步，回到扩展点「布防」`;
    document.documentElement.appendChild(toastHost);
    setTimeout(() => toastHost.remove(), 2400);
  }

  async function cancelRecording() {
    if (!recording) return;
    recording = false;
    hideOverlay();
    await send({ type: 'CANCEL_RECORDING' }, 5000);
  }

  function onDocumentClick(event) {
    if (!recording || suppressClick) return;
    if (overlay && event.composedPath && event.composedPath().includes(overlay.host)) return;

    const el = pickElement(event.target);
    if (!el || U.isEditable(el)) return;

    const label = U.accessibleName(el);
    if (U.isPaymentText(label)) {
      blockEvent(event);
      showToast('支付步骤不会记录，也不会执行', true);
      return;
    }

    const isSubmit = U.isSubmitText(label);
    const step = makeStep(el, 'click');
    blockEvent(event);

    const pending = send({ type: 'RECORDED_STEP', step }, 5000);
    pending.then((result) => {
      if (result && result.ok) {
        recordingCount = Number.isFinite(Number(result.count)) ? Number(result.count) : recordingCount + 1;
        updateOverlay();
        showToast(isSubmit ? '已记录提交步骤，并拦截了真实提交' : '已记录，继续点击下一步');
      } else {
        showToast((result && result.error) || '记录失败', true);
      }
    });

    if (isSubmit) return;

    // 先阻止页面跳转，等步骤写入后台后再重放点击，确保跳转前步骤不丢。
    // 正常 5–30ms 就能写入；最多等 300ms，避免后台繁忙时卡住页面。
    let replayed = false;
    const replay = () => {
      if (replayed || !el.isConnected) return;
      replayed = true;
      suppressClick = true;
      try {
        el.click();
      } catch (err) {
        /* ignore */
      }
      setTimeout(() => {
        suppressClick = false;
      }, 0);
    };
    setTimeout(replay, 300);
    pending.then(replay).catch(replay);
  }

  function onChangeCapture(event) {
    if (!recording || !recordInputs) return;
    const el = event.target;
    if (!U.isEditable(el)) return;
    const type = (el.getAttribute && el.getAttribute('type')) || '';
    if (type.toLowerCase() === 'password') {
      showToast('密码不会被记录', true);
      return;
    }
    const value = String(el.value == null ? '' : el.value);
    if (!value || value.length > 1000) return;
    const step = makeStep(el, 'input');
    step.value = value;
    send({ type: 'RECORDED_STEP', step }, 5000).then((result) => {
      if (result && result.ok) {
        recordingCount = Number.isFinite(Number(result.count)) ? Number(result.count) : recordingCount + 1;
        updateOverlay();
        showToast('已记录输入内容，仅保存在本机');
      }
    });
  }

  function makeStep(el, action) {
    const info = U.describeElement(el);
    return U.normalizeStep({
      ...info,
      action,
      selector: U.buildSelector(el),
      url: location.href,
      delayAfter: 180
    });
  }

  function blockEvent(event) {
    try {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    } catch (err) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * 定时执行
   * ------------------------------------------------------------------ */

  function armRun(payload) {
    if (!payload || !payload.runId) return;
    clearArmTimer();
    arm = {
      runId: payload.runId,
      targetLocal: Number(payload.targetLocal),
      steps: Array.isArray(payload.steps) ? payload.steps : [],
      index: Number(payload.index) || 0,
      timeoutMs: Number(payload.timeoutMs) || 12000,
      settings: payload.settings || {}
    };
    ensureKeepAlive();
    if (arm.index === 0 && Number.isFinite(arm.targetLocal)) {
      scheduleFirstStep();
    }
  }

  function cancelArm() {
    arm = null;
    clearArmTimer();
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  function clearArmTimer() {
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
  }

  function scheduleFirstStep() {
    if (!arm) return;
    const targetPerf = performance.now() + Math.max(0, arm.targetLocal - Date.now());
    const wait = () => {
      if (!arm) return;
      const left = targetPerf - performance.now();
      if (left <= 0) {
        fireFirstStep();
        return;
      }
      if (left <= 8) {
        // 最后几毫秒忙等，避免 setTimeout 的调度抖动
        while (performance.now() < targetPerf) {
          /* spin */
        }
        fireFirstStep();
        return;
      }
      if (left < 260) {
        armTimer = setTimeout(wait, Math.max(1, Math.min(4, left / 5)));
        return;
      }
      armTimer = setTimeout(wait, Math.min(left - 200, 1000));
    };
    wait();
  }

  async function fireFirstStep() {
    if (!arm) return;
    const runId = arm.runId;
    const index = arm.index;
    const step = arm.steps[index];
    if (!step) {
      notify({ type: 'STEP_RESULT', runId, index, ok: false, code: 'NO_STEP', reason: '没有可执行步骤' });
      return;
    }
    notify({ type: 'RUN_FIRED', runId, index, url: location.href });
    let result;
    try {
      result = await executeStep({
        runId,
        index,
        step,
        timeoutMs: arm.timeoutMs,
        settings: arm.settings
      });
    } catch (err) {
      result = { ok: false, code: 'EXEC_ERROR', reason: err && err.message ? err.message : '执行异常' };
    }
    notify({ type: 'STEP_RESULT', runId, index, ...result });
  }

  async function executeStep(message) {
    const runId = message.runId;
    const index = Number(message.index) || 0;
    const step = message.step;
    const timeoutMs = Math.max(1000, Number(message.timeoutMs) || 12000);
    const settings = message.settings || {};
    const checkChallenge = settings.checkChallenge !== false;

    if (message.runId && arm && arm.runId !== message.runId) {
      return { ok: false, code: 'RUN_MISMATCH', reason: '页面上的任务与后台不一致' };
    }
    if (!step) return { ok: false, code: 'NO_STEP', reason: '步骤为空' };

    await waitForDom(Math.min(timeoutMs, 8000));

    if (checkChallenge) {
      const challenge = U.detectChallenge();
      if (challenge) return { ok: false, code: 'CHALLENGE', reason: challenge.reason };
    }

    let el = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (checkChallenge) {
        const challenge = U.detectChallenge();
        if (challenge) return { ok: false, code: 'CHALLENGE', reason: challenge.reason };
      }
      el = U.findElement(step);
      if (el && !U.isDisabled(el)) break;
      await U.sleep(50);
    }

    if (!el) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        reason: `未找到「${U.summarizeStep(step)}」，页面可能已改版或尚未加载`
      };
    }
    if (U.isDisabled(el)) {
      return { ok: false, code: 'DISABLED', reason: `「${U.summarizeStep(step)}」一直是不可点击状态` };
    }

    const label = [step.text, step.ariaLabel, U.accessibleName(el)].filter(Boolean).join(' ');
    if (U.isPaymentText(label)) {
      return { ok: false, code: 'PAYMENT_BLOCKED', reason: '这一步是支付操作，已被安全策略拦截' };
    }

    if (message.dryRun) {
      flashElement(el);
      return { ok: true, dryRun: true, label: U.summarizeStep(step) };
    }

    if (step.action === 'input') {
      try {
        U.applyInputValue(el, step.value || '');
        return { ok: true, label: U.summarizeStep(step) };
      } catch (err) {
        return { ok: false, code: 'INPUT_FAILED', reason: err && err.message ? err.message : '输入失败' };
      }
    }

    // 先发消息再点击：消息已经进入扩展通道，页面跳转也不会丢失“已点击”的事实
    notify({ type: 'STEP_FIRING', runId, index, stepId: step.id, url: location.href, label });
    try {
      U.clickElement(el);
    } catch (err) {
      notify({
        type: 'STEP_ERROR',
        runId,
        index,
        reason: err && err.message ? err.message : '点击失败'
      });
      return { ok: false, code: 'CLICK_FAILED', reason: err && err.message ? err.message : '点击失败' };
    }
    return { ok: true, clicked: true, label: U.summarizeStep(step) };
  }

  function waitForDom(timeoutMs) {
    return new Promise((resolve) => {
      if (document.readyState !== 'loading') {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      document.addEventListener('DOMContentLoaded', finish, { once: true });
      setTimeout(finish, timeoutMs);
    });
  }

  function flashElement(el) {
    const rect = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.style.cssText =
      `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
      'border:3px solid #ff5a1f;background:rgba(255,90,31,.18);border-radius:6px;' +
      'z-index:2147483647;pointer-events:none;transition:opacity .25s;';
    document.documentElement.appendChild(box);
    setTimeout(() => {
      box.style.opacity = '0';
      setTimeout(() => box.remove(), 300);
    }, 500);
  }

  function ensureKeepAlive() {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      if (!arm) return;
      notify({ type: 'KEEPALIVE', runId: arm.runId, url: location.href });
    }, 15000);
  }

  async function checkSteps(message) {
    const steps = Array.isArray(message.steps) ? message.steps : [];
    const results = steps.map((step, index) => {
      const el = U.findElement(step);
      return {
        index,
        found: !!el,
        visible: el ? U.isVisible(el) : false,
        disabled: el ? U.isDisabled(el) : null,
        text: el ? U.accessibleName(el).slice(0, 60) : '',
        summary: U.summarizeStep(step)
      };
    });
    return { ok: true, results, url: location.href, title: document.title };
  }

  /* ------------------------------------------------------------------ *
   * 生命周期
   * ------------------------------------------------------------------ */

  async function handshake() {
    if (handshakeAttempts >= 20) return;
    handshakeAttempts += 1;
    const result = await send({ type: 'CONTENT_READY', url: location.href, title: document.title }, 6000);
    if (!result || !result.ok) {
      handshakeTimer = setTimeout(handshake, 900);
      return;
    }
    const settings = result.settings || {};
    if (result.recording) {
      startRecording({
        count: result.recording.count || 0,
        recordInputs: settings.recordInputs
      });
    } else if (recording) {
      stopRecordingLocal();
    }
    if (result.run && (result.run.status === U.RUN_STATUS.ARMED || result.run.status === U.RUN_STATUS.PREPARING)) {
      armRun({
        runId: result.run.runId,
        targetLocal: result.run.targetLocal,
        steps: result.run.steps,
        index: result.run.index || 0,
        timeoutMs: result.run.timeoutMs || settings.stepTimeoutMs,
        settings
      });
    }
  }

  function onPageHide() {
    clearArmTimer();
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (handshakeTimer) clearTimeout(handshakeTimer);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;

    switch (message.type) {
      case 'PING':
        sendResponse({ ok: true, url: location.href, title: document.title });
        return false;
      case 'PAGE_INFO':
        sendResponse({
          ok: true,
          url: location.href,
          title: document.title,
          readyState: document.readyState
        });
        return false;
      case 'START_RECORDING':
        startRecording(message);
        sendResponse({ ok: true });
        return false;
      case 'STOP_RECORDING':
        stopRecordingLocal();
        sendResponse({ ok: true });
        return false;
      case 'CANCEL_RECORDING':
        stopRecordingLocal();
        sendResponse({ ok: true });
        return false;
      case 'SET_RECORD_INPUTS':
        recordInputs = !!message.value;
        updateOverlay();
        sendResponse({ ok: true });
        return false;
      case 'RUN_ARMED':
        armRun(message);
        sendResponse({ ok: true });
        return false;
      case 'RUN_CANCELLED':
        cancelArm();
        sendResponse({ ok: true });
        return false;
      case 'EXEC_STEP':
        executeStep(message)
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, code: 'EXEC_ERROR', reason: err && err.message }));
        return true;
      case 'CHECK_STEPS':
        checkSteps(message)
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, error: err && err.message }));
        return true;
      case 'FLASH_TEXT':
        flashElement(document.body);
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });

  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('change', onChangeCapture, true);
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('pagehide', onPageHide, true);
  handshake();
})();
