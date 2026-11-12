(function () {
  'use strict';

  const U = globalThis.GrabUtils;
  const $ = (selector) => document.querySelector(selector);

  let state = null;
  let currentTab = null;
  let targetDirty = false;
  let toastTimer = null;
  let refreshTimer = null;
  let pollTimer = null;
  let checkResults = null;
  let autoSyncTried = false;

  const els = {};

  function cacheEls() {
    const ids = [
      'statusPill',
      'pageTitle',
      'pageUrl',
      'pageBadge',
      'pageHint',
      'recordBtn',
      'stopRecordBtn',
      'checkBtn',
      'stepCount',
      'stepsEmpty',
      'stepsList',
      'clearBtn',
      'helpBtn',
      'checkResult',
      'targetInput',
      'timeSource',
      'timeOffset',
      'syncBtn',
      'stepTimeout',
      'returnToStart',
      'refreshBeforeRun',
      'focusWindow',
      'notify',
      'runCard',
      'runTitle',
      'runSub',
      'runBadge',
      'runProgress',
      'runCountdown',
      'runMessage',
      'runActions',
      'runLogs',
      'logList',
      'footerHint',
      'armBtn',
      'cancelRunBtn',
      'disclaimer',
      'agreeCheck',
      'agreeBtn',
      'closeDisclaimerBtn',
      'toast'
    ];
    for (const id of ids) els[id] = document.getElementById(id);
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { ok: true });
          }
        });
      } catch (err) {
        resolve({ ok: false, error: err && err.message ? err.message : '扩展已重新加载' });
      }
    });
  }

  function showToast(text, isError) {
    if (!els.toast) return;
    els.toast.textContent = text;
    els.toast.classList.toggle('error', !!isError);
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
  }

  function isRestricted(url) {
    return /^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(String(url || ''));
  }

  function activeStatuses() {
    return [U.RUN_STATUS.ARMED, U.RUN_STATUS.PREPARING, U.RUN_STATUS.RUNNING, U.RUN_STATUS.PAUSED];
  }

  function isRunActive(run) {
    return !!run && activeStatuses().includes(run.status);
  }

  function displaySteps() {
    if (!state) return [];
    if (state.recording) return state.recording.steps || [];
    return state.steps || [];
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function render() {
    if (!state) return;
    renderPage();
    renderSteps();
    renderTime();
    renderRun();
    renderLogs();
    renderArmBar();
    renderStatus();
    renderDisclaimer();
  }

  function renderStatus() {
    const pill = els.statusPill;
    const run = state.run;
    let text = '待命';
    let cls = 'idle';
    if (state.recording) {
      text = '录制中';
      cls = 'recording';
    } else if (run) {
      const map = {
        armed: ['已布防', 'armed'],
        preparing: ['准备中', 'preparing'],
        running: ['执行中', 'running'],
        paused: ['需要处理', 'paused'],
        done: ['已提交', 'done'],
        failed: ['失败', 'failed']
      };
      if (map[run.status]) {
        text = map[run.status][0];
        cls = map[run.status][1];
      }
    }
    pill.textContent = text;
    pill.className = `pill ${cls}`;
  }

  function renderPage() {
    if (!currentTab) {
      els.pageTitle.textContent = '没有可操作的活动页面';
      els.pageUrl.textContent = '';
      els.pageBadge.classList.add('hidden');
      els.pageHint.textContent = '请先打开商品页或结算页，再点扩展图标。';
      els.recordBtn.disabled = true;
      els.checkBtn.disabled = true;
      return;
    }

    const restricted = isRestricted(currentTab.url);
    els.pageTitle.textContent = currentTab.title || '未命名页面';
    try {
      const url = new URL(currentTab.url);
      els.pageUrl.textContent = `${url.hostname}${url.pathname}`.slice(0, 90);
    } catch (err) {
      els.pageUrl.textContent = currentTab.url || '';
    }
    els.pageBadge.classList.toggle('hidden', restricted);
    if (!restricted) {
      els.pageBadge.textContent = '可操作';
    }

    const run = state.run;
    const recordingHere = state.recording && state.recording.tabId === currentTab.id;
    const recordingElsewhere = state.recording && !recordingHere;

    if (restricted) {
      els.pageHint.textContent = '浏览器内部页面不允许扩展操作，请切换到普通购物/票务网页。';
    } else if (recordingHere) {
      els.pageHint.textContent = '录制中：在页面上点击元素；完成后点页面底部悬浮条的「完成」。';
    } else if (recordingElsewhere) {
      els.pageHint.textContent = '另一个标签页正在录制，请切回那个标签页继续，或点「停止录制」。';
    } else if (isRunActive(run)) {
      els.pageHint.textContent = '任务已布防：请保持目标页面打开，不要锁屏或手动切换页面。';
    } else {
      els.pageHint.textContent = '在商品页或结算页点「开始录制」，按真实下单顺序点一遍。';
    }

    const cannotRecord = restricted || isRunActive(run);
    els.recordBtn.disabled = cannotRecord || !!state.recording;
    els.recordBtn.classList.toggle('hidden', !!state.recording);
    els.stopRecordBtn.classList.toggle('hidden', !state.recording);
    els.checkBtn.disabled = !displaySteps().length || restricted;
  }

  function renderSteps() {
    const steps = displaySteps();
    const recording = !!state.recording;
    const locked = isRunActive(state.run) || recording;
    els.stepCount.textContent = recording ? `${steps.length} 步 · 录制中` : `${steps.length} 步`;
    els.stepsEmpty.classList.toggle('hidden', steps.length > 0);
    els.stepsList.textContent = '';
    els.clearBtn.disabled = !steps.length || locked;

    steps.forEach((step, index) => {
      const row = document.createElement('div');
      row.className = 'step';

      const idx = document.createElement('div');
      idx.className = 'step-index';
      idx.textContent = String(index + 1);

      const body = document.createElement('div');
      body.className = 'step-body';
      const name = document.createElement('div');
      name.className = 'step-name';
      name.textContent = step.action === 'input' ? `输入：${stepName(step)}` : stepName(step);
      name.title = name.textContent;
      const selector = document.createElement('div');
      selector.className = 'step-selector';
      selector.textContent = step.selector || '(无选择器，运行时按文字匹配)';
      selector.title = selector.textContent;
      body.appendChild(name);
      body.appendChild(selector);

      const side = document.createElement('div');
      side.className = 'step-side';

      if (!recording) {
        const delayWrap = document.createElement('label');
        delayWrap.className = 'delay-wrap';
        delayWrap.title = '这一步点击后等待多久再执行下一步（毫秒）';
        const delayInput = document.createElement('input');
        delayInput.type = 'number';
        delayInput.min = '0';
        delayInput.max = '10000';
        delayInput.step = '50';
        delayInput.value = String(Number(step.delayAfter) || 0);
        delayInput.disabled = locked;
        delayInput.addEventListener('change', () => updateDelay(index, delayInput.value));
        const unit = document.createElement('span');
        unit.textContent = 'ms';
        delayWrap.appendChild(delayInput);
        delayWrap.appendChild(unit);
        side.appendChild(delayWrap);

        const up = iconButton('↑', '上移', () => moveStep(index, -1), locked || index === 0);
        const down = iconButton('↓', '下移', () => moveStep(index, 1), locked || index === steps.length - 1);
        const del = iconButton('×', '删除', () => deleteStep(index), locked, true);
        side.appendChild(up);
        side.appendChild(down);
        side.appendChild(del);
      }

      row.appendChild(idx);
      row.appendChild(body);
      row.appendChild(side);
      els.stepsList.appendChild(row);
    });
  }

  function stepName(step) {
    if (!step) return '未命名步骤';
    if (step.action === 'input') {
      return step.placeholder || step.ariaLabel || step.name || '输入框';
    }
    return step.text || step.ariaLabel || step.placeholder || step.name || '无文字按钮';
  }

  function iconButton(text, title, onClick, disabled, danger) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `icon-btn${danger ? ' danger' : ''}`;
    btn.textContent = text;
    btn.title = title;
    btn.disabled = !!disabled;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderTime() {
    const run = state.run;
    const locked = isRunActive(run);
    const timeCard = document.querySelector('.time-card');
    if (timeCard) timeCard.classList.toggle('hidden', locked);
    const offset = Number(state.time.offsetMs) || 0;
    const syncedAt = Number(state.time.syncedAt) || 0;
    const fresh = syncedAt && Date.now() - syncedAt < 30 * 60 * 1000;

    if (state.time.source && state.time.source !== 'local' && syncedAt) {
      els.timeSource.textContent = fresh ? `已校准 · ${state.time.source}` : `校准已过期 · ${state.time.source}`;
    } else {
      els.timeSource.textContent = '本机时间';
    }

    if (syncedAt) {
      const sign = offset > 0 ? '+' : '';
      els.timeOffset.textContent = `偏差 ${sign}${offset} ms · 往返 ${Math.round(state.time.rtt || 0)} ms${fresh ? '' : '（建议重新校准）'}`;
    } else {
      els.timeOffset.textContent = '未校准，使用本机时钟';
    }

    els.targetInput.disabled = locked;
    if (locked && run) {
      els.targetInput.value = U.toDateTimeLocalValue(run.targetLocal);
      targetDirty = false;
    } else if (!targetDirty && !els.targetInput.value) {
      const next = Math.ceil((Date.now() + 5 * 60 * 1000) / 1000) * 1000;
      els.targetInput.value = U.toDateTimeLocalValue(next);
    }

    // 高级设置
    if (document.activeElement !== els.stepTimeout) {
      els.stepTimeout.value = String(Math.round((state.settings.stepTimeoutMs || 12000) / 1000));
    }
    els.returnToStart.checked = !!state.settings.returnToStart;
    els.refreshBeforeRun.checked = !!state.settings.refreshBeforeRun;
    els.focusWindow.checked = !!state.settings.focusWindow;
    els.notify.checked = !!state.settings.notify;
  }

  function renderRun() {
    const run = state.run;
    if (!run || run.status === U.RUN_STATUS.CANCELLED) {
      els.runCard.classList.add('hidden');
      return;
    }
    els.runCard.classList.remove('hidden');
    els.runCard.dataset.status = run.status;

    const total = run.steps.length;
    const done = Math.min(Number(run.index) || 0, total);
    els.runProgress.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    els.runTitle.textContent = `任务 · ${total} 步`;
    els.runSub.textContent = `目标 ${U.formatDateTime(run.targetLocal)}`;

    const statusMap = {
      armed: ['已布防', '倒计时中，请保持页面打开。'],
      preparing: ['准备中', '正在切换/刷新页面并准备计时器。'],
      running: ['执行中', `正在执行第 ${Math.min(done + 1, total)}/${total} 步。`],
      paused: ['需要处理', run.pauseReason || '需要人工处理'],
      done: ['已提交', '已执行到最后一步，请立即检查页面并付款。'],
      failed: ['失败', run.error || '执行失败']
    };
    const info = statusMap[run.status] || ['任务', ''];
    els.runBadge.textContent = info[0];
    els.runMessage.textContent = info[1];

    els.runActions.textContent = '';
    if (run.status === U.RUN_STATUS.PAUSED) {
      els.runActions.appendChild(makeButton('继续执行', 'primary', () => resumeRun(run)));
      els.runActions.appendChild(makeButton('取消', 'ghost', () => cancelRun(run)));
    } else if (run.status === U.RUN_STATUS.ARMED || run.status === U.RUN_STATUS.PREPARING || run.status === U.RUN_STATUS.RUNNING) {
      els.runActions.appendChild(makeButton('取消任务', 'ghost', () => cancelRun(run)));
    } else {
      els.runActions.appendChild(makeButton('打开目标页面', 'primary', () => openRunTab(run)));
      els.runActions.appendChild(makeButton('重新布防', 'ghost', () => {
        targetDirty = true;
        els.targetInput.focus();
      }));
    }

    els.runLogs.textContent = '';
    const logs = (run.logs || []).slice(-4);
    for (const log of logs) {
      const row = document.createElement('div');
      row.className = 'run-log';
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = U.formatClock(log.ts, false);
      const m = document.createElement('span');
      m.textContent = log.message;
      row.appendChild(t);
      row.appendChild(m);
      els.runLogs.appendChild(row);
    }

    const showBigCountdown = ![U.RUN_STATUS.DONE, U.RUN_STATUS.FAILED].includes(run.status);
    els.runCountdown.style.display = showBigCountdown ? 'block' : 'none';
    if (run.status === U.RUN_STATUS.PAUSED) {
      els.runCountdown.textContent = '已暂停';
    }
  }

  function makeButton(text, variant, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${variant}`;
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderLogs() {
    const merged = new Map();
    const all = [...(state.logs || []), ...((state.run && state.run.logs) || [])];
    for (const log of all) {
      merged.set(`${log.ts}-${log.message}`, log);
    }
    const logs = Array.from(merged.values())
      .sort((a, b) => a.ts - b.ts)
      .slice(-8);
    els.logList.textContent = '';
    if (!logs.length) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = '暂无日志';
      els.logList.appendChild(empty);
      return;
    }
    for (const log of logs) {
      const row = document.createElement('div');
      row.className = `log-row ${log.level || ''}`;
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = U.formatClock(log.ts, false);
      const m = document.createElement('span');
      m.textContent = log.message;
      row.appendChild(t);
      row.appendChild(m);
      els.logList.appendChild(row);
    }
  }

  function renderArmBar() {
    const run = state.run;
    const active = isRunActive(run);
    els.armBtn.classList.toggle('hidden', active);
    els.cancelRunBtn.classList.toggle('hidden', !active);

    if (active) {
      els.cancelRunBtn.textContent = run.status === U.RUN_STATUS.PAUSED ? '取消暂停的任务' : '取消任务';
      return;
    }

    const steps = displaySteps();
    let label = '布防 · 定时执行';
    let disabled = false;
    if (state.recording) {
      label = '录制中，请先完成';
      disabled = true;
    } else if (!steps.length) {
      label = '先录制步骤';
      disabled = true;
    } else if (!currentTab || isRestricted(currentTab.url)) {
      label = '当前页面不可操作';
      disabled = true;
    } else if (!els.targetInput.value) {
      label = '先设置目标时间';
      disabled = true;
    }
    els.armBtn.textContent = label;
    els.armBtn.disabled = disabled;

    if (state.recording) {
      els.footerHint.textContent = '录制中：点击页面元素，完成后点悬浮条「完成」';
    } else if (active) {
      els.footerHint.textContent = '任务执行期间请不要锁屏或手动切换页面';
    } else {
      els.footerHint.textContent = '只执行你录制的步骤，不碰支付密码。';
    }
  }

  function renderDisclaimer() {
    const accepted = !!state.disclaimerAccepted;
    els.disclaimer.classList.toggle('hidden', accepted);
  }

  /* ------------------------------------------------------------------ *
   * 倒计时
   * ------------------------------------------------------------------ */

  function tick() {
    const run = state && state.run;
    if (!run) return;
    if (run.status === U.RUN_STATUS.ARMED || run.status === U.RUN_STATUS.PREPARING) {
      const left = run.targetLocal - Date.now();
      els.runCountdown.textContent = U.formatCountdown(left);
      if (left <= 0) {
        els.runMessage.textContent = '已到目标时间，正在执行…';
      }
    } else if (run.status === U.RUN_STATUS.RUNNING) {
      const elapsed = Date.now() - run.targetLocal;
      els.runCountdown.textContent = `+${U.formatCountdown(elapsed)}`;
    }
  }

  /* ------------------------------------------------------------------ *
   * 操作
   * ------------------------------------------------------------------ */

  async function refresh() {
    const [stateRes, tabs] = await Promise.all([
      send({ type: 'GET_STATE' }),
      chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [])
    ]);
    if (stateRes && stateRes.ok) state = stateRes.state;
    // 调试/自动化测试时可指定标签页；正常弹窗没有这个参数，取当前活动页。
    const forcedTabId = Number(new URLSearchParams(location.search).get('tabId'));
    if (Number.isFinite(forcedTabId) && forcedTabId > 0) {
      currentTab = await chrome.tabs.get(forcedTabId).catch(() => null);
    } else {
      currentTab = tabs && tabs[0] ? tabs[0] : null;
    }
    render();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 80);
  }

  async function startRecording() {
    if (!state.disclaimerAccepted) {
      renderDisclaimer();
      return;
    }
    if (!currentTab) {
      showToast('找不到当前页面', true);
      return;
    }
    if (isRestricted(currentTab.url)) {
      showToast('这个页面不允许扩展操作', true);
      return;
    }
    if (isRunActive(state.run)) {
      showToast('请先取消当前任务', true);
      return;
    }
    const result = await send({ type: 'START_RECORDING', tabId: currentTab.id });
    if (!result.ok) {
      showToast(result.error || '启动录制失败', true);
      return;
    }
    checkResults = null;
    showToast('录制已开始，请在页面上点击');
    setTimeout(() => window.close(), 350);
  }

  async function stopRecording() {
    const result = await send({ type: 'STOP_RECORDING' });
    if (!result.ok) {
      showToast(result.error || '停止录制失败', true);
      return;
    }
    targetDirty = false;
    showToast(`已保存 ${result.count || 0} 步`);
    await refresh();
  }

  async function checkSteps() {
    const steps = displaySteps();
    if (!steps.length) {
      showToast('还没有步骤', true);
      return;
    }
    if (!currentTab) {
      showToast('找不到当前页面', true);
      return;
    }
    els.checkBtn.disabled = true;
    els.checkBtn.innerHTML = '<span class="spin"></span>检查中';
    const result = await send({ type: 'CHECK_STEPS', tabId: currentTab.id, steps });
    els.checkBtn.textContent = '检查步骤';
    els.checkBtn.disabled = false;
    if (!result.ok) {
      showToast(result.error || '检查失败', true);
      return;
    }
    checkResults = result;
    renderCheckResult();
    els.checkResult.scrollIntoView({ block: 'nearest' });
  }

  function renderCheckResult() {
    if (!checkResults || !Array.isArray(checkResults.results)) {
      els.checkResult.classList.add('hidden');
      return;
    }
    els.checkResult.classList.remove('hidden');
    els.checkResult.textContent = '';
    const found = checkResults.results.filter((item) => item.found).length;
    const head = document.createElement('div');
    head.className = 'check-line';
    head.innerHTML = `<span class="${found === checkResults.results.length ? 'check-ok' : 'check-bad'}">●</span>` +
      `<span>当前页匹配 ${found}/${checkResults.results.length} 步（只检查当前页，跳转后的步骤需到对应页面再检查）</span>`;
    els.checkResult.appendChild(head);

    for (const item of checkResults.results) {
      const line = document.createElement('div');
      line.className = 'check-line';
      const mark = document.createElement('span');
      mark.className = item.found ? 'check-ok' : 'check-bad';
      mark.textContent = item.found ? '✓' : '✗';
      const text = document.createElement('span');
      text.textContent = item.found
        ? `第 ${item.index + 1} 步：${item.summary}${item.text ? `（匹配到「${item.text}」）` : ''}`
        : `第 ${item.index + 1} 步：${item.summary} — 当前页未找到`;
      line.appendChild(mark);
      line.appendChild(text);
      els.checkResult.appendChild(line);
    }
  }

  async function arm() {
    if (!state.disclaimerAccepted) {
      renderDisclaimer();
      return;
    }
    const steps = displaySteps();
    if (!steps.length) {
      showToast('还没有步骤', true);
      return;
    }
    if (!currentTab) {
      showToast('找不到当前页面', true);
      return;
    }
    if (isRestricted(currentTab.url)) {
      showToast('这个页面不允许扩展操作', true);
      return;
    }
    const targetEpoch = U.parseTargetTime(els.targetInput.value);
    if (!Number.isFinite(targetEpoch)) {
      showToast('请选择有效的目标时间', true);
      return;
    }
    const targetLocal = U.computeTargetLocal(targetEpoch, state.time.offsetMs);
    if (targetLocal < Date.now() + U.MIN_TARGET_AHEAD_MS) {
      showToast('目标时间太近，至少留 2 秒', true);
      return;
    }

    els.armBtn.disabled = true;
    els.armBtn.innerHTML = '<span class="spin"></span>布防中';
    const result = await send({
      type: 'ARM',
      tabId: currentTab.id,
      targetEpoch,
      steps,
      startUrl: state.stepsStartUrl || currentTab.url
    });
    els.armBtn.textContent = '布防 · 定时执行';
    if (!result.ok) {
      els.armBtn.disabled = false;
      showToast(result.error || '布防失败', true);
      return;
    }
    targetDirty = false;
    showToast('布防成功，请保持页面打开');
    await refresh();
  }

  async function cancelRun(run) {
    if (!run) return;
    if (!window.confirm('确定取消当前任务？已经执行的步骤不会回退。')) return;
    const result = await send({ type: 'CANCEL_RUN', runId: run.runId });
    if (!result.ok) {
      showToast(result.error || '取消失败', true);
      return;
    }
    showToast('任务已取消');
    await refresh();
  }

  async function resumeRun(run) {
    const result = await send({ type: 'RESUME', runId: run.runId });
    if (!result.ok) {
      showToast(result.error || '继续失败', true);
      return;
    }
    showToast('已继续执行');
    await refresh();
  }

  async function openRunTab(run) {
    try {
      const tab = await chrome.tabs.get(run.tabId);
      await chrome.tabs.update(run.tabId, { active: true });
      if (tab && tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      window.close();
    } catch (err) {
      showToast('目标页面已关闭，无法打开', true);
    }
  }

  async function syncTime(silent) {
    if (els.syncBtn.disabled) return;
    els.syncBtn.disabled = true;
    els.syncBtn.innerHTML = '<span class="spin" style="border-color:#c9c5bd;border-top-color:#ff5a1f"></span>校准中';
    const result = await send({ type: 'SYNC_TIME' });
    els.syncBtn.disabled = false;
    els.syncBtn.textContent = '校准网络时间';
    if (!result.ok) {
      if (!silent) showToast(result.error || '校准失败，继续使用本机时间', true);
      return;
    }
    state.time = {
      offsetMs: result.offsetMs,
      rtt: result.rtt,
      source: result.source,
      syncedAt: Date.now()
    };
    renderTime();
    if (!silent) {
      const sign = result.offsetMs > 0 ? '+' : '';
      showToast(`校准完成：${result.source}，偏差 ${sign}${result.offsetMs} ms`);
    }
  }

  async function saveSettings() {
    const seconds = Number(els.stepTimeout.value);
    const settings = {
      stepTimeoutMs: U.clamp(Number.isFinite(seconds) ? seconds : 12, 1, 120) * 1000,
      returnToStart: els.returnToStart.checked,
      refreshBeforeRun: els.refreshBeforeRun.checked,
      focusWindow: els.focusWindow.checked,
      notify: els.notify.checked
    };
    const result = await send({ type: 'UPDATE_SETTINGS', settings });
    if (result.ok) {
      state.settings = result.settings;
      showToast('设置已保存');
    } else {
      showToast(result.error || '设置保存失败', true);
    }
  }

  async function updateDelay(index, value) {
    const steps = state.steps.map((step) => ({ ...step }));
    if (!steps[index]) return;
    steps[index].delayAfter = U.clamp(Number(value) || 0, 0, 10000);
    const result = await send({ type: 'UPDATE_STEPS', steps });
    if (result.ok) {
      state.steps = result.steps;
    } else {
      showToast(result.error || '保存失败', true);
    }
  }

  async function moveStep(index, delta) {
    const steps = state.steps.map((step) => ({ ...step }));
    const next = index + delta;
    if (next < 0 || next >= steps.length) return;
    [steps[index], steps[next]] = [steps[next], steps[index]];
    const result = await send({ type: 'UPDATE_STEPS', steps });
    if (result.ok) {
      state.steps = result.steps;
      renderSteps();
    } else {
      showToast(result.error || '移动失败', true);
    }
  }

  async function deleteStep(index) {
    const steps = state.steps.filter((_, i) => i !== index);
    const result = await send({ type: 'UPDATE_STEPS', steps });
    if (result.ok) {
      state.steps = result.steps;
      checkResults = null;
      renderSteps();
      renderCheckResult();
    } else {
      showToast(result.error || '删除失败', true);
    }
  }

  async function clearSteps() {
    if (!displaySteps().length) return;
    if (!window.confirm('清空所有已录制步骤？')) return;
    const result = await send({ type: 'CLEAR_STEPS' });
    if (!result.ok) {
      showToast(result.error || '清空失败', true);
      return;
    }
    checkResults = null;
    targetDirty = false;
    await refresh();
    showToast('已清空步骤');
  }

  function setQuickTarget(seconds) {
    const target = Math.ceil((Date.now() + seconds * 1000) / 100) * 100;
    els.targetInput.value = U.toDateTimeLocalValue(target);
    targetDirty = true;
    renderArmBar();
  }

  async function acceptDisclaimer() {
    if (!els.agreeCheck.checked) return;
    const result = await send({ type: 'DISMISS_DISCLAIMER' });
    if (!result.ok) {
      showToast(result.error || '保存失败', true);
      return;
    }
    state.disclaimerAccepted = true;
    renderDisclaimer();
  }

  function openHelp() {
    chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
    window.close();
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  function bind() {
    els.recordBtn.addEventListener('click', startRecording);
    els.stopRecordBtn.addEventListener('click', stopRecording);
    els.checkBtn.addEventListener('click', checkSteps);
    els.clearBtn.addEventListener('click', clearSteps);
    els.helpBtn.addEventListener('click', openHelp);
    els.syncBtn.addEventListener('click', () => syncTime(false));
    els.armBtn.addEventListener('click', arm);
    els.cancelRunBtn.addEventListener('click', () => cancelRun(state.run));

    els.targetInput.addEventListener('input', () => {
      targetDirty = true;
      renderArmBar();
    });

    els.quickChips = document.getElementById('quickChips');
    els.quickChips.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-seconds]');
      if (!btn) return;
      setQuickTarget(Number(btn.dataset.seconds));
    });

    for (const input of [els.stepTimeout, els.returnToStart, els.refreshBeforeRun, els.focusWindow, els.notify]) {
      input.addEventListener('change', saveSettings);
    }

    els.agreeCheck.addEventListener('change', () => {
      els.agreeBtn.disabled = !els.agreeCheck.checked;
    });
    els.agreeBtn.addEventListener('click', acceptDisclaimer);
    els.closeDisclaimerBtn.addEventListener('click', () => window.close());

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !els.disclaimer.classList.contains('hidden')) {
        window.close();
      }
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === 'STATE_CHANGED') scheduleRefresh();
      return false;
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.grabStateV1) scheduleRefresh();
    });
  }

  async function init() {
    cacheEls();
    bind();
    await refresh();
    if (!state) {
      showToast('无法读取扩展状态，请重新打开', true);
      return;
    }
    setInterval(tick, 100);
    pollTimer = setInterval(() => {
      if (state && isRunActive(state.run)) scheduleRefresh();
    }, 2500);
    if (state.time && (!state.time.syncedAt || Date.now() - state.time.syncedAt > 30 * 60 * 1000)) {
      if (!autoSyncTried) {
        autoSyncTried = true;
        syncTime(true);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
