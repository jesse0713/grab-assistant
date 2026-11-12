/*
 * 抢单助手 - 后台 Service Worker
 * 负责：录制状态、倒计时调度、跨页面步骤编排、失败/验证码暂停、通知。
 */
importScripts('shared/utils.js');

const U = self.GrabUtils;
const STORAGE_KEY = 'grabStateV1';
const ALARM_NAME = 'grab-wake';
const BADGE_COLORS = {
  armed: '#2563eb',
  preparing: '#b45309',
  running: '#ff5a1f',
  paused: '#b42318',
  done: '#0f7b4f',
  failed: '#b42318',
  recording: '#ff4d4f'
};

let cachedState = null;
let stateQueue = Promise.resolve();
const activeRunCounts = new Map();
const preparingRuns = new Set();

function beginActiveRun(runId) {
  activeRunCounts.set(runId, (activeRunCounts.get(runId) || 0) + 1);
}

function endActiveRun(runId) {
  const next = (activeRunCounts.get(runId) || 0) - 1;
  if (next <= 0) activeRunCounts.delete(runId);
  else activeRunCounts.set(runId, next);
}

function isRunActive(runId) {
  return (activeRunCounts.get(runId) || 0) > 0;
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

function emptyState() {
  return {
    version: 1,
    disclaimerAccepted: false,
    steps: [],
    stepsStartUrl: '',
    recording: null,
    run: null,
    settings: { ...U.DEFAULT_SETTINGS },
    time: { offsetMs: 0, rtt: 0, source: 'local', syncedAt: 0 },
    logs: []
  };
}

function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const base = emptyState();
  const state = {
    ...base,
    ...source,
    settings: U.normalizeSettings(source.settings),
    time: {
      offsetMs: Number(source.time && source.time.offsetMs) || 0,
      rtt: Number(source.time && source.time.rtt) || 0,
      source: String((source.time && source.time.source) || 'local'),
      syncedAt: Number(source.time && source.time.syncedAt) || 0
    },
    steps: Array.isArray(source.steps) ? source.steps.slice(0, U.MAX_STEPS).map(U.normalizeStep) : [],
    stepsStartUrl: String(source.stepsStartUrl || ''),
    logs: Array.isArray(source.logs) ? source.logs.slice(-30) : []
  };

  if (source.recording && typeof source.recording === 'object' && Array.isArray(source.recording.steps)) {
    state.recording = {
      tabId: Number(source.recording.tabId) || null,
      startUrl: String(source.recording.startUrl || ''),
      startedAt: Number(source.recording.startedAt) || Date.now(),
      steps: source.recording.steps.slice(0, U.MAX_STEPS).map(U.normalizeStep)
    };
  } else {
    state.recording = null;
  }

  if (source.run && typeof source.run === 'object') {
    state.run = {
      ...source.run,
      runId: String(source.run.runId || U.uid()),
      status: String(source.run.status || U.RUN_STATUS.ARMED),
      index: Number(source.run.index) || 0,
      steps: Array.isArray(source.run.steps) ? source.run.steps.slice(0, U.MAX_STEPS).map(U.normalizeStep) : [],
      targetEpoch: Number(source.run.targetEpoch) || 0,
      targetLocal: Number(source.run.targetLocal) || 0,
      tabId: Number(source.run.tabId) || null,
      startUrl: String(source.run.startUrl || ''),
      timeoutMs: Number(source.run.timeoutMs) || U.DEFAULT_SETTINGS.stepTimeoutMs,
      advanceSeq: Number(source.run.advanceSeq) || 0,
      logs: Array.isArray(source.run.logs) ? source.run.logs.slice(-40) : []
    };
  } else {
    state.run = null;
  }
  return state;
}

async function loadState(force) {
  if (cachedState && !force) return cachedState;
  const data = await chrome.storage.local.get(STORAGE_KEY);
  cachedState = normalizeState(data[STORAGE_KEY]);
  return cachedState;
}

async function saveState(state) {
  cachedState = state;
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function withState(fn) {
  const task = stateQueue.then(async () => {
    const state = await loadState(true);
    const result = await fn(state);
    await saveState(state);
    return result;
  });
  stateQueue = task.catch(() => {});
  return task;
}

function broadcastState() {
  chrome.runtime
    .sendMessage({ type: 'STATE_CHANGED' })
    .catch(() => {
      /* 弹窗没打开时会没有接收方 */
    });
}

/* ------------------------------------------------------------------ *
 * 日志 / 通知 / 徽标
 * ------------------------------------------------------------------ */

function appendLog(state, message, level) {
  const entry = {
    ts: Date.now(),
    level: level || 'info',
    message: String(message || '').slice(0, 300)
  };
  state.logs = [...(state.logs || []), entry].slice(-30);
  if (state.run) {
    state.run.logs = [...(state.run.logs || []), entry].slice(-40);
  }
}

function notify(title, message) {
  (async () => {
    const state = await loadState();
    if (!state.settings.notify) return;
    try {
      await chrome.notifications.create(`grab-${Date.now()}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title,
        message,
        priority: 2
      });
    } catch (err) {
      /* 通知失败不影响主流程 */
    }
  })();
}

async function setBadge(text, color, title) {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
    if (title) await chrome.action.setTitle({ title });
  } catch (err) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * 标签页 / 内容脚本
 * ------------------------------------------------------------------ */

function isRestrictedUrl(url) {
  return /^(chrome|edge|about|devtools|chrome-extension|moz-extension|view-source):/i.test(String(url || ''));
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (err) {
    return null;
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

function sendToTab(tabId, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('页面响应超时'));
    }, timeoutMs || 5000);
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response || { ok: true });
        }
      });
    } catch (err) {
      clearTimeout(timer);
      settled = true;
      reject(err);
    }
  });
}

async function ensureContent(tabId) {
  try {
    const pong = await sendToTab(tabId, { type: 'PING' }, 900);
    if (pong && pong.ok) return true;
  } catch (err) {
    /* 页面还没注入内容脚本 */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['shared/utils.js', 'content/content.js']
    });
  } catch (err) {
    return false;
  }
  await U.sleep(80);
  try {
    const pong = await sendToTab(tabId, { type: 'PING' }, 1200);
    return !!(pong && pong.ok);
  } catch (err) {
    return false;
  }
}

function stripHash(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch (err) {
    return String(url || '').split('#')[0];
  }
}

async function waitTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 25000);
  let last = null;
  while (Date.now() < deadline) {
    const tab = await getTab(tabId);
    if (!tab) throw new Error('目标标签页已关闭');
    last = tab;
    if (tab.status === 'complete') {
      await U.sleep(150);
      return tab;
    }
    await U.sleep(120);
  }
  throw new Error(`页面加载超时${last && last.url ? `：${last.url}` : ''}`);
}

/* ------------------------------------------------------------------ *
 * 时间校准
 * ------------------------------------------------------------------ */

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 5000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function syncTime() {
  const candidates = [
    {
      source: 'timeapi.io',
      url: 'https://timeapi.io/api/Time/current/zone?timeZone=UTC',
      read: (json) => {
        const value = String(json.dateTime || '');
        const iso = /Z$|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`;
        return new Date(iso).getTime();
      }
    },
    {
      source: '淘宝时间接口',
      url: 'https://api.m.taobao.com/rest/api3.do?api=mtop.common.getTimestamp',
      read: (json) => Number(json && json.data && json.data.t)
    },
    {
      source: 'worldtimeapi.org',
      url: 'https://worldtimeapi.org/api/timezone/Etc/UTC',
      read: (json) => new Date(json.utc_datetime || '').getTime()
    }
  ];

  const results = [];
  for (const item of candidates) {
    const start = Date.now();
    try {
      const json = await fetchWithTimeout(item.url, 4500);
      const end = Date.now();
      const server = item.read(json);
      if (!Number.isFinite(server) || server <= 0) continue;
      const offsetMs = Math.round(server - (start + end) / 2);
      results.push({ source: item.source, offsetMs, rtt: end - start });
    } catch (err) {
      /* 换下一个时间源 */
    }
  }
  if (!results.length) {
    return { ok: false, error: '网络时间校准失败，将使用本机时间' };
  }
  results.sort((a, b) => a.rtt - b.rtt);
  const best = results[0];
  const state = await withState((s) => {
    s.time = {
      offsetMs: best.offsetMs,
      rtt: best.rtt,
      source: best.source,
      syncedAt: Date.now()
    };
    appendLog(s, `时间已校准：${best.source}，偏差 ${best.offsetMs >= 0 ? '+' : ''}${best.offsetMs} ms`, 'info');
    return s.time;
  });
  broadcastState();
  return { ok: true, ...state };
}

/* ------------------------------------------------------------------ *
 * 录制
 * ------------------------------------------------------------------ */

async function startRecording(msg, sender) {
  const tab = msg.tabId ? await getTab(Number(msg.tabId)) : await getActiveTab();
  if (!tab) return { ok: false, error: '找不到当前标签页' };
  if (isRestrictedUrl(tab.url)) return { ok: false, error: '这个页面不允许扩展操作，请打开普通网页' };

  const state = await loadState(true);
  if (state.run && [U.RUN_STATUS.ARMED, U.RUN_STATUS.PREPARING, U.RUN_STATUS.RUNNING, U.RUN_STATUS.PAUSED].includes(state.run.status)) {
    return { ok: false, error: '已有任务在布防或执行，请先取消任务' };
  }
  if (state.recording && state.recording.tabId !== tab.id) {
    return { ok: false, error: '另一个标签页正在录制，请先回到那个标签页完成或取消' };
  }

  const next = await withState((s) => {
    s.recording = {
      tabId: tab.id,
      startUrl: tab.url,
      startedAt: Date.now(),
      steps: []
    };
    s.run = null;
    appendLog(s, `开始录制：${tab.title || tab.url}`, 'info');
    return s.recording;
  });

  if (!(await ensureContent(tab.id))) {
    await withState((s) => {
      s.recording = null;
    });
    return { ok: false, error: '无法在这个页面启动录制，请刷新页面后重试' };
  }

  try {
    await sendToTab(
      tab.id,
      {
        type: 'START_RECORDING',
        count: next.steps.length,
        recordInputs: state.settings.recordInputs
      },
      3000
    );
  } catch (err) {
    /* 页面可能刚跳转，内容脚本会通过握手恢复 */
  }

  await setBadge('录', BADGE_COLORS.recording, '正在录制点击步骤');
  broadcastState();
  return { ok: true };
}

async function stopRecording() {
  const previous = await loadState(true);
  const recordingTabId = previous.recording ? previous.recording.tabId : null;
  const state = await withState((s) => {
    if (!s.recording) return { count: s.steps.length, steps: s.steps };
    const recorded = s.recording.steps;
    if (recorded.length > 0) {
      s.steps = recorded;
      s.stepsStartUrl = s.recording.startUrl;
    }
    const count = s.steps.length;
    appendLog(s, `录制完成，共 ${count} 步`, 'success');
    s.recording = null;
    return { count, steps: s.steps };
  });
  if (recordingTabId) {
    try {
      await sendToTab(recordingTabId, { type: 'STOP_RECORDING' }, 1200);
    } catch (err) {
      /* 页面可能已关闭 */
    }
  }
  await setBadge('', null, '抢单助手');
  broadcastState();
  return { ok: true, ...state };
}

async function cancelRecording() {
  const previous = await loadState(true);
  const recordingTabId = previous.recording ? previous.recording.tabId : null;
  await withState((s) => {
    s.recording = null;
    appendLog(s, '已取消本次录制', 'info');
  });
  if (recordingTabId) {
    try {
      await sendToTab(recordingTabId, { type: 'CANCEL_RECORDING' }, 1200);
    } catch (err) {
      /* ignore */
    }
  }
  await setBadge('', null, '抢单助手');
  broadcastState();
  return { ok: true };
}

async function recordStep(msg, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (!tabId) return { ok: false, error: '只能从网页上录制步骤' };
  const step = U.normalizeStep(msg.step);
  const result = await withState((s) => {
    if (!s.recording || s.recording.tabId !== tabId) {
      return { ok: false, error: '录制已结束，这一步没有保存' };
    }
    if (s.recording.steps.length >= U.MAX_STEPS) {
      return { ok: false, error: `最多录制 ${U.MAX_STEPS} 步` };
    }
    const last = s.recording.steps[s.recording.steps.length - 1];
    if (step.action === 'input' && last && last.action === 'input' && last.selector === step.selector) {
      last.value = step.value;
      return { ok: true, count: s.recording.steps.length };
    }
    step.recordedAt = Date.now();
    s.recording.steps.push(step);
    return { ok: true, count: s.recording.steps.length };
  });
  broadcastState();
  return result;
}

/* ------------------------------------------------------------------ *
 * 布防 / 调度
 * ------------------------------------------------------------------ */

function validateStepsForRun(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return '还没有录制步骤';
  if (steps.length > U.MAX_STEPS) return `最多 ${U.MAX_STEPS} 步`;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const label = [step.text, step.ariaLabel].filter(Boolean).join(' ');
    if (U.isPaymentText(label)) {
      return `第 ${i + 1} 步是支付操作（${label}），请删除后再布防`;
    }
  }
  return '';
}

async function armRun(msg) {
  const state = await loadState(true);
  if (!state.disclaimerAccepted) return { ok: false, error: '请先阅读并同意使用须知' };
  if (state.recording) return { ok: false, error: '录制还没结束，请先点「完成」' };

  const tab = msg.tabId ? await getTab(Number(msg.tabId)) : await getActiveTab();
  if (!tab) return { ok: false, error: '找不到当前标签页' };
  if (isRestrictedUrl(tab.url)) return { ok: false, error: '这个页面不允许扩展操作' };

  const steps = Array.isArray(msg.steps) && msg.steps.length ? msg.steps.map(U.normalizeStep) : state.steps;
  const stepError = validateStepsForRun(steps);
  if (stepError) return { ok: false, error: stepError };

  const targetEpoch = Number(msg.targetEpoch);
  if (!Number.isFinite(targetEpoch) || targetEpoch <= 0) return { ok: false, error: '目标时间无效' };

  const offsetMs = Number(state.time.offsetMs) || 0;
  const targetLocal = U.computeTargetLocal(targetEpoch, offsetMs);
  const now = Date.now();
  if (targetLocal < now + U.MIN_TARGET_AHEAD_MS) {
    return { ok: false, error: '目标时间太近，至少留 2 秒准备时间' };
  }
  if (targetLocal > now + U.MAX_TARGET_AHEAD_MS) {
    return { ok: false, error: '目标时间不能超过 7 天后' };
  }

  const startUrl = String(msg.startUrl || state.stepsStartUrl || tab.url);
  if (isRestrictedUrl(startUrl)) return { ok: false, error: '录制起点页面不可操作，请重新录制' };
  try {
    new URL(startUrl);
  } catch (err) {
    return { ok: false, error: '录制起点地址无效，请重新录制' };
  }
  const run = {
    runId: U.uid(),
    status: U.RUN_STATUS.ARMED,
    index: 0,
    steps,
    targetEpoch,
    targetLocal,
    tabId: tab.id,
    startUrl,
    createdAt: now,
    updatedAt: now,
    timeoutMs: state.settings.stepTimeoutMs,
    settings: { ...state.settings },
    advanceSeq: 0,
    logs: []
  };

  await withState((s) => {
    s.run = run;
    s.steps = steps;
    s.stepsStartUrl = startUrl;
    appendLog(s, `已布防：${U.formatDateTime(targetLocal)}，共 ${steps.length} 步`, 'success');
  });

  await chrome.alarms.clear(ALARM_NAME);
  await setBadge('待', BADGE_COLORS.armed, `已布防，目标 ${U.formatDateTime(targetLocal)}`);
  notify('已布防', `${U.formatClock(targetLocal, true)} 执行，共 ${steps.length} 步。请在电脑前等待。`);

  // 立即把倒计时交给页面，页面上的计时器才是毫秒级精度的关键
  if (await ensureContent(tab.id)) {
    try {
      await sendToTab(
        tab.id,
        {
          type: 'RUN_ARMED',
          runId: run.runId,
          targetLocal,
          steps,
          index: 0,
          timeoutMs: run.timeoutMs,
          settings: run.settings
        },
        3000
      );
    } catch (err) {
      /* 页面会在握手时重新拿到任务 */
    }
  }

  scheduleWake(run);
  broadcastState();
  return { ok: true, run };
}

async function scheduleWake(run) {
  const now = Date.now();
  const prepareAt = run.targetLocal - 20000;
  if (prepareAt <= now + 1000) {
    setTimeout(() => prepareRun(run.runId), Math.max(100, prepareAt - now));
    return;
  }
  try {
    await chrome.alarms.create(ALARM_NAME, { when: prepareAt });
  } catch (err) {
    /* ignore */
  }
}

async function prepareRun(runId) {
  if (preparingRuns.has(runId)) return;
  preparingRuns.add(runId);
  try {
    let state = await loadState(true);
    let run = state.run;
    if (!run || run.runId !== runId) return;
    if (![U.RUN_STATUS.ARMED, U.RUN_STATUS.PREPARING].includes(run.status)) return;
    if (Date.now() > run.targetLocal + 15000) {
      await failRun(runId, '目标时间已经过去，任务没有执行');
      return;
    }

    await withState((s) => {
      if (!s.run || s.run.runId !== runId) return;
      s.run.status = U.RUN_STATUS.PREPARING;
      s.run.updatedAt = Date.now();
      appendLog(s, '开始准备：切换到目标页面', 'info');
    });
    await setBadge('备', BADGE_COLORS.preparing, '正在准备执行');
    broadcastState();

    let tab = await getTab(run.tabId);
    if (!tab) {
      // 标签页被关掉时重新打开录制时的页面
      try {
        tab = await chrome.tabs.create({ url: run.startUrl, active: true });
        await waitTabComplete(tab.id, 25000);
        state = await withState((s) => {
          if (s.run && s.run.runId === runId) {
            s.run.tabId = tab.id;
            return s.run;
          }
          return null;
        });
        if (!state) return;
        run = state;
      } catch (err) {
        await failRun(runId, '目标标签页已关闭，且无法重新打开');
        return;
      }
    }

    try {
      await chrome.tabs.update(tab.id, { active: true });
      if (run.settings.focusWindow) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch (err) {
      /* 窗口焦点失败不阻断执行 */
    }

    if (tab.status !== 'complete') {
      try {
        tab = await waitTabComplete(tab.id, 20000);
      } catch (err) {
        await failRun(runId, '目标页面加载超时，请刷新后重试');
        return;
      }
    }

    if (run.settings.returnToStart && stripHash(tab.url) !== stripHash(run.startUrl)) {
      try {
        await chrome.tabs.update(tab.id, { url: run.startUrl });
        await waitTabComplete(tab.id, 25000);
      } catch (err) {
        await failRun(runId, '无法回到录制页面');
        return;
      }
    } else if (run.settings.refreshBeforeRun) {
      try {
        await chrome.tabs.reload(tab.id);
        await waitTabComplete(tab.id, 25000);
      } catch (err) {
        await failRun(runId, '执行前刷新页面失败');
        return;
      }
    }

    const ok = await ensureContent(tab.id);
    if (!ok) {
      await failRun(runId, '无法连接目标页面，请刷新页面后重新布防');
      return;
    }

    const latest = await loadState(true);
    if (!latest.run || latest.run.runId !== runId) return;
    run = latest.run;

    try {
      await sendToTab(
        tab.id,
        {
          type: 'RUN_ARMED',
          runId: run.runId,
          targetLocal: run.targetLocal,
          steps: run.steps,
          index: run.index,
          timeoutMs: run.timeoutMs,
          settings: run.settings
        },
        3000
      );
    } catch (err) {
      await failRun(runId, '页面没有响应，请刷新后重试');
      return;
    }

    await withState((s) => {
      if (!s.run || s.run.runId !== runId) return;
      appendLog(s, '页面已就绪，等待目标时间', 'info');
    });

    const waitMs = Math.max(3000, run.targetLocal - Date.now() + 6000);
    setTimeout(() => checkRunStarted(runId), waitMs);
  } finally {
    preparingRuns.delete(runId);
  }
}

async function checkRunStarted(runId) {
  const state = await loadState(true);
  const run = state.run;
  if (!run || run.runId !== runId) return;
  if (run.status === U.RUN_STATUS.PREPARING) {
    await failRun(runId, '目标时间已到，但页面没有执行第一步，请检查页面是否被刷新或跳转');
  }
}

/* ------------------------------------------------------------------ *
 * 执行编排
 * ------------------------------------------------------------------ */

async function advanceFromStep(runId, index, meta) {
  const result = await withState((s) => {
    const run = s.run;
    if (!run || run.runId !== runId) return null;
    if (run.lastFiredIndex === index && Date.now() - (run.lastFiredAt || 0) < 5000) {
      return null;
    }
    if (index < run.index - 1) return null;
    const step = run.steps[index];
    const label = (meta && meta.label) || U.summarizeStep(step);
    run.status = U.RUN_STATUS.RUNNING;
    run.lastFiredIndex = index;
    run.lastFiredAt = Date.now();
    run.index = Math.max(run.index, index + 1);
    run.lastUrl = (meta && meta.url) || run.lastUrl || '';
    run.pendingNav = U.looksLikeNavigation(`${label} ${(step && step.text) || ''}`);
    run.updatedAt = Date.now();
    run.advanceSeq = (run.advanceSeq || 0) + 1;
    appendLog(s, `第 ${index + 1}/${run.steps.length} 步：${label}`, 'info');
    return { index, seq: run.advanceSeq, nextIndex: run.index, total: run.steps.length };
  });

  if (!result) return;
  await setBadge('跑', BADGE_COLORS.running, `正在执行第 ${result.index + 1}/${result.total} 步`);
  broadcastState();

  setTimeout(
    () => continueRun(runId, result.nextIndex, result.seq),
    Math.max(80, Number(cachedState && cachedState.run && cachedState.run.steps[result.index] && cachedState.run.steps[result.index].delayAfter) || 160)
  );
}

async function continueRun(runId, expectedIndex, seq) {
  beginActiveRun(runId);
  try {
    let state = await loadState(true);
    let run = state.run;
    if (!run || run.runId !== runId) return;
    if (run.status !== U.RUN_STATUS.RUNNING) return;
    if (run.advanceSeq !== seq) return;
    if (run.index !== expectedIndex) return;

    if (run.index >= run.steps.length) {
      await finishRun(runId);
      return;
    }

    let tab = await getTab(run.tabId);
    if (!tab) {
      await failRun(runId, '目标标签页已关闭');
      return;
    }

    try {
      tab = await settleAfterClick(run, tab);
    } catch (err) {
      const latest = await loadState(true);
      if (!latest.run || latest.run.runId !== runId || latest.run.advanceSeq !== seq) return;
      await failRun(runId, err && err.message ? err.message : '页面加载失败');
      return;
    }
    if (!tab) return;

    let lastError = null;
    for (let attempt = 0; attempt < 45; attempt += 1) {
      state = await loadState(true);
      run = state.run;
      if (!run || run.runId !== runId || run.status !== U.RUN_STATUS.RUNNING || run.advanceSeq !== seq) {
        return;
      }
      tab = await getTab(run.tabId);
      if (!tab) {
        await failRun(runId, '目标标签页已关闭');
        return;
      }
      if (tab.status !== 'complete') {
        await U.sleep(150);
        continue;
      }
      if (!(await ensureContent(tab.id))) {
        await U.sleep(200);
        continue;
      }

      const step = run.steps[run.index];
      try {
        const response = await sendToTab(
          tab.id,
          {
            type: 'EXEC_STEP',
            runId,
            index: run.index,
            step,
            timeoutMs: run.timeoutMs,
            settings: run.settings
          },
          run.timeoutMs + 5000
        );

        // 页面可能在点击后已经跳转，先确认这次执行仍然是最新的一步
        const latest = await loadState(true);
        if (!latest.run || latest.run.runId !== runId || latest.run.advanceSeq !== seq) return;

        if (response && response.ok) {
          // 点击步骤会先发 STEP_FIRING；输入步骤只返回结果，需要在这里推进
          await advanceFromStep(runId, run.index, { label: response.label, url: tab.url });
          return;
        }
        if (response && response.ok === false) {
          await handleStepFailure(runId, response);
          return;
        }
      } catch (err) {
        lastError = err;
      }
      await U.sleep(220);
    }
    await failRun(runId, `页面一直没有准备好：${lastError ? lastError.message : '无法连接页面'}`);
  } finally {
    endActiveRun(runId);
  }
}

async function settleAfterClick(run, tab) {
  const beforeUrl = run.lastUrl || tab.url;
  const graceMs = run.pendingNav ? 2600 : 700;
  const start = Date.now();
  let changed = false;
  while (Date.now() - start < graceMs) {
    const current = await getTab(tab.id);
    if (!current) throw new Error('目标标签页已关闭');
    if (current.status === 'loading' || current.url !== beforeUrl) {
      changed = true;
      tab = current;
      break;
    }
    await U.sleep(80);
  }
  if (!changed) return tab;

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const current = await getTab(tab.id);
    if (!current) throw new Error('目标标签页已关闭');
    tab = current;
    if (current.status === 'complete') {
      await U.sleep(180);
      return current;
    }
    await U.sleep(120);
  }
  throw new Error('点击后页面加载超时');
}

async function handleStepFailure(runId, response) {
  const reason = response.reason || '步骤执行失败';
  const code = response.code || '';
  if (code === 'CHALLENGE') {
    await pauseRun(runId, reason);
    return;
  }
  if (code === 'PAYMENT_BLOCKED') {
    await failRun(runId, '检测到支付操作，安全策略已停止执行');
    return;
  }
  await failRun(runId, reason);
}

async function finishRun(runId) {
  const state = await withState((s) => {
    if (!s.run || s.run.runId !== runId) return null;
    if ([U.RUN_STATUS.FAILED, U.RUN_STATUS.CANCELLED].includes(s.run.status)) return null;
    s.run.status = U.RUN_STATUS.DONE;
    s.run.index = s.run.steps.length;
    s.run.finishedAt = Date.now();
    s.run.updatedAt = Date.now();
    appendLog(s, '已执行完最后一步，请立即检查页面并付款', 'success');
    return s.run;
  });
  if (!state) return;
  await chrome.alarms.clear(ALARM_NAME);
  try {
    await sendToTab(state.tabId, { type: 'RUN_CANCELLED' }, 800);
  } catch (err) {
    /* 页面可能已经跳走 */
  }
  await setBadge('✓', BADGE_COLORS.done, '已提交，请付款');
  broadcastState();
  notify('已执行到最后一步', '请立即回到页面确认订单并完成付款。付款需要你手动操作。');
}

async function failRun(runId, message) {
  const state = await withState((s) => {
    if (!s.run || s.run.runId !== runId) return null;
    if ([U.RUN_STATUS.DONE, U.RUN_STATUS.CANCELLED].includes(s.run.status)) return null;
    s.run.status = U.RUN_STATUS.FAILED;
    s.run.error = String(message || '执行失败');
    s.run.finishedAt = Date.now();
    s.run.updatedAt = Date.now();
    appendLog(s, `执行失败：${message}`, 'error');
    return s.run;
  });
  if (!state) return;
  await chrome.alarms.clear(ALARM_NAME);
  try {
    await sendToTab(state.tabId, { type: 'RUN_CANCELLED' }, 800);
  } catch (err) {
    /* ignore */
  }
  await setBadge('!', BADGE_COLORS.failed, '执行失败');
  broadcastState();
  notify('执行失败', String(message || '请打开扩展查看详情'));
}

async function pauseRun(runId, reason) {
  const state = await withState((s) => {
    if (!s.run || s.run.runId !== runId) return null;
    if ([U.RUN_STATUS.DONE, U.RUN_STATUS.CANCELLED].includes(s.run.status)) return null;
    s.run.status = U.RUN_STATUS.PAUSED;
    s.run.pauseReason = String(reason || '需要人工处理');
    s.run.updatedAt = Date.now();
    appendLog(s, `已暂停：${reason}`, 'warn');
    return s.run;
  });
  if (!state) return;
  try {
    await sendToTab(state.tabId, { type: 'RUN_CANCELLED' }, 800);
  } catch (err) {
    /* ignore */
  }
  await setBadge('!', BADGE_COLORS.paused, '需要人工处理');
  broadcastState();
  notify('需要人工处理', String(reason || '请在页面上完成后，回到扩展点“继续”'));
}

async function cancelRun(runId) {
  const state = await withState((s) => {
    if (!s.run || (runId && s.run.runId !== runId)) return null;
    s.run.status = U.RUN_STATUS.CANCELLED;
    s.run.finishedAt = Date.now();
    s.run.updatedAt = Date.now();
    appendLog(s, '任务已取消', 'warn');
    return s.run;
  });
  if (!state) return { ok: true };
  await chrome.alarms.clear(ALARM_NAME);
  await setBadge('', null, '抢单助手');
  try {
    await sendToTab(state.tabId, { type: 'RUN_CANCELLED' }, 1000);
  } catch (err) {
    /* ignore */
  }
  broadcastState();
  return { ok: true };
}

async function resumeRun(runId) {
  const state = await loadState(true);
  const run = state.run;
  if (!run || run.runId !== runId) return { ok: false, error: '任务不存在' };
  if (run.status !== U.RUN_STATUS.PAUSED) return { ok: false, error: '当前任务不在暂停状态' };

  if (run.index === 0 && run.targetLocal > Date.now() + 800) {
    await withState((s) => {
      if (s.run && s.run.runId === runId) {
        s.run.status = U.RUN_STATUS.PREPARING;
        s.run.updatedAt = Date.now();
      }
    });
    await setBadge('备', BADGE_COLORS.preparing, '继续等待目标时间');
    const tab = await getTab(run.tabId);
    if (tab && (await ensureContent(tab.id))) {
      try {
        await sendToTab(
          tab.id,
          {
            type: 'RUN_ARMED',
            runId,
            targetLocal: run.targetLocal,
            steps: run.steps,
            index: 0,
            timeoutMs: run.timeoutMs,
            settings: run.settings
          },
          3000
        );
      } catch (err) {
        /* ignore */
      }
    }
    scheduleWake({ ...run, status: U.RUN_STATUS.PREPARING });
    broadcastState();
    return { ok: true };
  }

  const next = await withState((s) => {
    if (!s.run || s.run.runId !== runId) return null;
    s.run.status = U.RUN_STATUS.RUNNING;
    s.run.updatedAt = Date.now();
    s.run.advanceSeq = (s.run.advanceSeq || 0) + 1;
    appendLog(s, '用户已确认，继续执行', 'info');
    return { index: s.run.index, seq: s.run.advanceSeq };
  });
  if (!next) return { ok: false, error: '任务不存在' };
  await setBadge('跑', BADGE_COLORS.running, '继续执行');
  broadcastState();
  continueRun(runId, next.index, next.seq);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 检查步骤
 * ------------------------------------------------------------------ */

async function checkSteps(msg, sender) {
  const state = await loadState(true);
  const steps = Array.isArray(msg.steps) && msg.steps.length ? msg.steps.map(U.normalizeStep) : state.steps;
  if (!steps.length) return { ok: false, error: '还没有步骤' };
  const tab = msg.tabId ? await getTab(Number(msg.tabId)) : sender && sender.tab ? sender.tab : await getActiveTab();
  if (!tab) return { ok: false, error: '找不到当前标签页' };
  if (isRestrictedUrl(tab.url)) return { ok: false, error: '这个页面不允许扩展操作' };
  if (!(await ensureContent(tab.id))) return { ok: false, error: '无法连接页面，请刷新后重试' };
  try {
    const result = await sendToTab(tab.id, { type: 'CHECK_STEPS', steps }, 6000);
    return { ok: true, ...result, tabId: tab.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * 消息入口
 * ------------------------------------------------------------------ */

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'GET_STATE': {
      const state = await loadState(true);
      return { ok: true, state, now: Date.now() };
    }
    case 'DISMISS_DISCLAIMER': {
      await withState((s) => {
        s.disclaimerAccepted = true;
      });
      broadcastState();
      return { ok: true };
    }
    case 'SYNC_TIME':
      return syncTime();
    case 'START_RECORDING':
      return startRecording(msg, sender);
    case 'STOP_RECORDING':
      return stopRecording();
    case 'CANCEL_RECORDING':
      return cancelRecording();
    case 'SET_RECORD_INPUTS': {
      const settings = await withState((s) => {
        s.settings.recordInputs = !!msg.value;
        return s.settings;
      });
      if (sender && sender.tab) {
        try {
          await sendToTab(sender.tab.id, { type: 'SET_RECORD_INPUTS', value: !!msg.value }, 1200);
        } catch (err) {
          /* ignore */
        }
      }
      broadcastState();
      return { ok: true, settings };
    }
    case 'RECORDED_STEP':
      return recordStep(msg, sender);
    case 'UPDATE_STEPS': {
      const steps = Array.isArray(msg.steps) ? msg.steps.slice(0, U.MAX_STEPS).map(U.normalizeStep) : [];
      const state = await loadState(true);
      if (state.recording) return { ok: false, error: '请先结束录制' };
      if (state.run && [U.RUN_STATUS.ARMED, U.RUN_STATUS.PREPARING, U.RUN_STATUS.RUNNING, U.RUN_STATUS.PAUSED].includes(state.run.status)) {
        return { ok: false, error: '请先取消当前任务' };
      }
      for (let i = 0; i < steps.length; i += 1) {
        if (U.isPaymentText([steps[i].text, steps[i].ariaLabel].join(' '))) {
          return { ok: false, error: `第 ${i + 1} 步是支付操作，不能保存` };
        }
      }
      await withState((s) => {
        s.steps = steps;
      });
      broadcastState();
      return { ok: true, steps };
    }
    case 'CLEAR_STEPS': {
      const state = await loadState(true);
      if (state.run && [U.RUN_STATUS.ARMED, U.RUN_STATUS.PREPARING, U.RUN_STATUS.RUNNING, U.RUN_STATUS.PAUSED].includes(state.run.status)) {
        return { ok: false, error: '请先取消当前任务' };
      }
      await withState((s) => {
        s.steps = [];
        s.stepsStartUrl = '';
        s.run = null;
        appendLog(s, '已清空步骤', 'info');
      });
      broadcastState();
      return { ok: true };
    }
    case 'CHECK_STEPS':
      return checkSteps(msg, sender);
    case 'ARM':
      return armRun(msg);
    case 'DISARM': {
      const state = await loadState(true);
      if (!state.run) return { ok: true };
      return cancelRun(state.run.runId);
    }
    case 'CANCEL_RUN':
      return cancelRun(msg.runId);
    case 'RESUME':
      return resumeRun(msg.runId || (await loadState(true)).run?.runId);
    case 'UPDATE_SETTINGS': {
      const settings = await withState((s) => {
        s.settings = U.normalizeSettings({ ...s.settings, ...(msg.settings || {}) });
        return s.settings;
      });
      broadcastState();
      return { ok: true, settings };
    }
    case 'CONTENT_READY': {
      const state = await loadState(true);
      const tabId = sender && sender.tab ? sender.tab.id : null;
      const sameTabRun = state.run && tabId && state.run.tabId === tabId ? state.run : null;
      return {
        ok: true,
        tabId,
        settings: state.settings,
        recording:
          state.recording && tabId && state.recording.tabId === tabId
            ? { count: state.recording.steps.length, startUrl: state.recording.startUrl }
            : null,
        run: sameTabRun
      };
    }
    case 'RUN_FIRED': {
      await withState((s) => {
        if (!s.run || s.run.runId !== msg.runId) return;
        s.run.status = U.RUN_STATUS.RUNNING;
        s.run.lastFiredAt = Date.now();
        s.run.updatedAt = Date.now();
        appendLog(s, '到达目标时间，开始执行', 'info');
      });
      await setBadge('跑', BADGE_COLORS.running, '正在执行');
      broadcastState();
      return { ok: true };
    }
    case 'STEP_FIRING':
      await advanceFromStep(msg.runId, Number(msg.index), msg);
      return { ok: true };
    case 'STEP_RESULT': {
      if (msg.ok === false) {
        await handleStepFailure(msg.runId, msg);
      } else {
        // 第一步可能不是点击（例如输入），没有 STEP_FIRING，需要在这里推进。
        // 点击步骤已经由 STEP_FIRING 推进过，advanceFromStep 会按 index 去重。
        await advanceFromStep(msg.runId, Number(msg.index), msg);
      }
      return { ok: true };
    }
    case 'STEP_ERROR':
      await failRun(msg.runId, msg.reason || '点击失败');
      return { ok: true };
    case 'KEEPALIVE': {
      const state = await loadState(true);
      const run = state.run;
      if (
        run &&
        run.status === U.RUN_STATUS.RUNNING &&
        !isRunActive(run.runId) &&
        Date.now() - (run.lastFiredAt || run.targetLocal || 0) > run.timeoutMs + 10000
      ) {
        // 后台被浏览器休眠后不要盲目重放下一步，避免重复点击/重复下单。
        // 让用户确认当前页面状态，再手动点“继续”。
        await pauseRun(run.runId, '后台被浏览器休眠，请确认页面状态后点“继续”');
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: `未知消息：${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;
  handleMessage(message, sender)
    .then((result) => sendResponse(result || { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : '后台处理失败' }));
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const state = await loadState(true);
  const run = state.run;
  if (!run) return;
  if (![U.RUN_STATUS.ARMED, U.RUN_STATUS.PREPARING].includes(run.status)) return;
  if (run.targetLocal - Date.now() > 25000) {
    scheduleWake(run);
    return;
  }
  prepareRun(run.runId);
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await loadState(true);
  if (!state.run) return;
  if (state.run.status === U.RUN_STATUS.RUNNING) {
    await pauseRun(state.run.runId, '浏览器重新启动，执行已暂停。请确认页面状态后点“继续”');
  } else if ([U.RUN_STATUS.ARMED, U.RUN_STATUS.PREPARING].includes(state.run.status)) {
    scheduleWake(state.run);
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const state = await loadState(true);
  if (details.reason === 'install') {
    state.disclaimerAccepted = false;
    await saveState(state);
    await setBadge('', null, '抢单助手');
  }
});
