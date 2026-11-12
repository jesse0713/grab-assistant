/*
 * 端到端测试：真实 Chrome for Testing + 真实扩展 + 本地模拟商城。
 * 运行前需先启动：python -m http.server 8765 --bind 127.0.0.1
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CDP, listTargets, waitForTarget } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHROME = path.join(ROOT, '.tools', 'chrome-win64', 'chrome.exe');
const PROFILE = path.join(ROOT, '.chrome-e2e');
const PORT = 18080;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOP_URL = 'http://127.0.0.1:8765/test/mock-shop.html';
const SHOT_DIR = path.join(ROOT, 'test', 'screenshots');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(fn, timeoutMs, intervalMs = 120, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`);
}

async function httpJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

async function launchChrome() {
  assert(fs.existsSync(CHROME), `找不到 Chrome for Testing：${CHROME}`);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const log = fs.openSync(path.join(ROOT, 'chrome-e2e.log'), 'w');
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    `--disable-extensions-except=${path.join(ROOT, 'extension')}`,
    `--load-extension=${path.join(ROOT, 'extension')}`,
    '--window-size=1280,900',
    '--window-position=-1800,-1200',
    SHOP_URL
  ];
  const child = spawn(CHROME, args, { stdio: ['ignore', log, log] });
  await waitFor(
    async () => {
      try {
        const response = await fetch(`${BASE}/json/version`);
        return response.ok;
      } catch (err) {
        return false;
      }
    },
    25000,
    250,
    'Chrome 调试端口'
  );
  return child;
}

async function openTab(url) {
  const response = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`打开标签页失败：HTTP ${response.status}`);
  return response.json();
}

async function connectTarget(target) {
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return cdp;
}

async function findOurServiceWorker() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const targets = (await listTargets()).filter((target) => target.type === 'service_worker');
    for (const target of targets) {
      let cdp = null;
      try {
        cdp = await CDP.connect(target.webSocketDebuggerUrl);
        await cdp.send('Runtime.enable');
        const manifest = await cdp.evaluate('({ name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version, id: chrome.runtime.id })');
        if (manifest && manifest.name.includes('抢单助手')) {
          return { target, cdp, manifest };
        }
      } catch (err) {
        /* 不是我们的，或连接失败 */
      }
      if (cdp) cdp.close();
    }
    await sleep(300);
  }
  return null;
}

async function clickAt(cdp, selector) {
  try {
    await cdp.send('Page.bringToFront');
  } catch (err) {
    /* ignore */
  }
  const rect = await waitFor(
    async () => {
      try {
        return await cdp.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return null;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
      } catch (err) {
        return null;
      }
    },
    12000,
    100,
    `元素 ${selector}`
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: rect.x,
    y: rect.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: rect.x,
    y: rect.y,
    button: 'left',
    buttons: 0,
    clickCount: 1
  });
}

async function waitForUrl(cdp, part, timeoutMs = 20000) {
  return waitFor(
    async () => {
      try {
        const href = await cdp.evaluate('location.href');
        return href.includes(part) ? href : null;
      } catch (err) {
        return null;
      }
    },
    timeoutMs,
    120,
    `URL 包含 ${part}`
  );
}

async function waitForSelector(cdp, selector, timeoutMs = 12000) {
  return waitFor(
    async () => {
      try {
        return await cdp.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
      } catch (err) {
        return false;
      }
    },
    timeoutMs,
    120,
    `选择器 ${selector}`
  );
}

async function getState(sw, popup) {
  try {
    return await sw.evaluate(`(async () => {
      const data = await chrome.storage.local.get('grabStateV1');
      return data.grabStateV1;
    })()`);
  } catch (err) {
    return popup.evaluate(`(async () => {
      const result = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      return result.state;
    })()`);
  }
}

async function screenshot(cdp, file) {
  try {
    await cdp.send('Page.bringToFront').catch(() => {});
    await sleep(250);
    const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  } catch (err) {
    console.log(`截图跳过（${path.basename(file)}）：${err.message}`);
  }
}

async function main() {
  let child = null;
  let sw = null;
  let popup = null;
  let shop = null;

  try {
    child = await launchChrome();

    const worker = await findOurServiceWorker();
    assert(worker, '扩展 Service Worker 没有启动，检查 --load-extension 是否生效');
    const extensionId = worker.manifest.id;
    console.log(`扩展 ID：${extensionId} / v${worker.manifest.version}`);
    sw = worker.cdp;

    const shopTarget = await waitForTarget(
      (target) => target.type === 'page' && target.url.includes('/test/mock-shop.html'),
      15000
    );
    assert(shopTarget, '模拟商城页面没有打开');

    // 先等标签页 URL 可读，再连接页面调试会话
    const tabs = await waitFor(
      async () => {
        const list = await sw.evaluate(`(async () => {
          const items = await chrome.tabs.query({});
          return items.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, status: tab.status, active: tab.active }));
        })()`);
        const found = list.find((tab) => tab.url && tab.url.includes('/test/mock-shop.html') && tab.status === 'complete');
        return found ? list : null;
      },
      15000,
      250,
      '模拟商城标签页 URL 可读'
    );
    console.log('SW tabs:', tabs.map((tab) => `${tab.id} ${tab.status} ${tab.url}`));
    const shopTab = tabs.find((tab) => tab.url && tab.url.includes('/test/mock-shop.html'));
    assert(shopTab, '找不到模拟商城标签页');

    shop = await connectTarget(shopTarget);
    shop.on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args || [])
        .map((arg) => (arg.value !== undefined ? arg.value : arg.description || ''))
        .join(' ');
      if (text.includes('[grab]')) console.log('PAGE LOG:', text);
    });
    console.log('shop location:', await shop.evaluate('location.href'));

    // 打开带 tabId 的弹窗，模拟真实弹窗锁定目标页
    let popupTarget = await openTab(`chrome-extension://${extensionId}/popup/popup.html?tabId=${shopTab.id}`);
    popup = await connectTarget(popupTarget);
    popup.on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args || [])
        .map((arg) => (arg.value !== undefined ? arg.value : arg.description || ''))
        .join(' ');
      if (text.includes('[popup]')) console.log('POPUP LOG:', text);
    });
    popup.on('Runtime.exceptionThrown', (params) => {
      console.log('POPUP EXCEPTION:', params.exceptionDetails?.exception?.description || params.exceptionDetails?.text);
    });

    await waitFor(
      async () => popup.evaluate(`document.getElementById('pageTitle').textContent !== '正在读取当前页面…'`),
      10000,
      100,
      '弹窗初始化'
    );
    await waitFor(
      async () => popup.evaluate(`document.getElementById('disclaimer') && !document.getElementById('disclaimer').classList.contains('hidden')`),
      8000,
      100,
      '使用须知显示'
    );
    await popup.evaluate(`(() => {
      const check = document.getElementById('agreeCheck');
      check.checked = true;
      check.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('agreeBtn').click();
      return true;
    })()`);
    await waitFor(
      async () => popup.evaluate(`document.getElementById('disclaimer').classList.contains('hidden')`),
      5000,
      100,
      '使用须知关闭'
    );

    await screenshot(popup, path.join(SHOT_DIR, 'popup-idle.png'));
    console.log('已保存弹窗截图：popup-idle.png');

    // 开始录制
    await popup.evaluate(`document.getElementById('recordBtn').click()`);
    await waitForSelector(shop, '#grab-assistant-host', 8000);
    await screenshot(shop, path.join(SHOT_DIR, 'recording-overlay.png'));
    console.log('录制已开始');

    // 关掉测试用的弹窗标签页，并把目标页切到前台，否则 CDP 鼠标事件不会送到后台标签页
    try {
      await sw.evaluate(`(async () => {
        const tabs = await chrome.tabs.query({});
        const popupTab = tabs.find((tab) => tab.url && tab.url.includes('/popup/popup.html'));
        if (popupTab) await chrome.tabs.remove(popupTab.id);
        await chrome.tabs.update(${shopTab.id}, { active: true });
        const target = await chrome.tabs.get(${shopTab.id});
        await chrome.windows.update(target.windowId, { focused: true });
        return true;
      })()`);
    } catch (err) {
      console.log('切换前台失败:', err.message);
    }
    popup.close();
    popup = null;
    await sleep(500);
    console.log('page focus after activate:', await shop.evaluate('document.hasFocus()'));

    console.log('page focus:', await shop.evaluate('({focus:document.hasFocus(), w:innerWidth, h:innerHeight, dpr:devicePixelRatio, overlay:!!document.getElementById("grab-assistant-host")})'));

    // 第 1 步：选择规格（同页点击，会被拦截并重放）
    await shop.evaluate(`document.getElementById('specBtn').click()`);
    await sleep(700);
    const specText = await shop.evaluate(`document.getElementById('specBtn').textContent`);
    assert(specText.includes('典藏版'), `规格点击没有被重放：${specText}`);

    // 第 2 步：立即购买（跳转）
    await shop.evaluate(`document.getElementById('buyBtn').click()`);
    await waitForUrl(shop, '/test/mock-checkout.html', 12000);
    await waitForSelector(shop, '#grab-assistant-host', 8000);
    console.log('已跳转到结算页，录制悬浮条已恢复');

    // 第 3 步：提交订单（录制时必须被拦截）
    await shop.evaluate(`document.getElementById('submitBtn').click()`);
    await sleep(900);
    const stillCheckout = (await shop.evaluate('location.href')).includes('/test/mock-checkout.html');
    const ordersBeforeArm = await shop.evaluate(`localStorage.getItem('mockOrders')`);
    assert(stillCheckout, '录制「提交订单」时不应真的跳转到收银台');
    assert(!ordersBeforeArm, '录制「提交订单」时不应创建订单');

    // 完成录制
    await shop.evaluate(`document.getElementById('grab-assistant-host').shadowRoot.querySelector('[data-act="done"]').click()`);
    await sleep(1200);

    const state = await getState(sw, popup);
    assert(state && Array.isArray(state.steps), '没有读到步骤');
    assert(state.steps.length === 3, `期望 3 步，实际 ${state.steps.length} 步`);
    assert(state.steps[2].text.includes('提交订单'), `最后一步不是提交订单：${state.steps[2].text}`);
    assert(state.stepsStartUrl.includes('/test/mock-shop.html'), `录制起点不正确：${state.stepsStartUrl}`);
    console.log('步骤：', state.steps.map((step) => step.text).join(' → '));

    // 重新打开弹窗（开始录制时弹窗可能已经关闭）
    let popupTarget2 = await openTab(`chrome-extension://${extensionId}/popup/popup.html?tabId=${shopTab.id}`);
    if (popup) popup.close();
    popup = await connectTarget(popupTarget2);
    await waitFor(
      async () => popup.evaluate(`document.getElementById('pageTitle').textContent !== '正在读取当前页面…'`),
      10000,
      100,
      '弹窗初始化'
    );
    await waitFor(
      async () => popup.evaluate(`document.getElementById('armBtn') && !document.getElementById('armBtn').disabled`),
      8000,
      100,
      '布防按钮可用'
    );

    // 设置 +10 秒并布防
    const targetValue = await popup.evaluate(`(() => {
      const d = new Date(Date.now() + 10000);
      const p = (n, l = 2) => String(n).padStart(l, '0');
      const value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
        '.' + p(d.getMilliseconds(), 3);
      const input = document.getElementById('targetInput');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return value;
    })()`);
    console.log('目标时间：', targetValue);
    console.log('arm before:', await popup.evaluate(`({
      disabled: document.getElementById('armBtn').disabled,
      text: document.getElementById('armBtn').textContent,
      pageTitle: document.getElementById('pageTitle').textContent,
      hint: document.getElementById('pageHint').textContent,
      value: document.getElementById('targetInput').value
    })`));
    await popup.evaluate(`document.getElementById('armBtn').click()`);
    await sleep(1200);
    console.log('arm after:', await popup.evaluate(`({
      disabled: document.getElementById('armBtn').disabled,
      text: document.getElementById('armBtn').textContent,
      toast: document.getElementById('toast').textContent
    })`));
    console.log('toast after arm:', await popup.evaluate(`document.getElementById('toast').textContent`));
    console.log('target input:', await popup.evaluate(`document.getElementById('targetInput').value`));
    console.log('state after arm:', JSON.stringify(await getState(sw, popup)).slice(0, 1200));

    const armed = await waitFor(
      async () => {
        const current = await getState(sw, popup);
        return current && current.run && ['armed', 'preparing'].includes(current.run.status) ? current.run : null;
      },
      6000,
      120,
      '任务进入布防/准备'
    );
    console.log('已布防，runId =', armed.runId, 'status =', armed.status);
    await screenshot(popup, path.join(SHOT_DIR, 'popup-armed.png'));

    await waitForUrl(shop, '/test/mock-pay.html', 25000);
    console.log('已到达模拟收银台');
    await sleep(800);

    const orders = await shop.evaluate(`JSON.parse(localStorage.getItem('mockOrders') || '[]')`);
    assert(orders.length === 1, `期望创建 1 个订单，实际 ${orders.length}`);
    const paymentClicked = await shop.evaluate(`localStorage.getItem('paymentClicked')`);
    assert(!paymentClicked, '扩展不应点击支付按钮');

    const finalState = await getState(sw, popup);
    assert(finalState.run && finalState.run.status === 'done', `任务状态不是 done：${finalState.run && finalState.run.status}`);
    console.log('执行完成，订单号：', orders[0].id);

    // 弹窗完成态截图
    const donePopupTarget = await openTab(`chrome-extension://${extensionId}/popup/popup.html?tabId=${shopTab.id}`);
    if (popup) popup.close();
    popup = await connectTarget(donePopupTarget);
    await sleep(1000);
    await screenshot(popup, path.join(SHOT_DIR, 'popup-done.png'));
    await screenshot(shop, path.join(SHOT_DIR, 'pay-page.png'));
    console.log('已保存截图：popup-done.png / pay-page.png');

    // 安全边界：录制时点支付按钮必须被拦截，既不记录也不触发支付
    await popup.evaluate(`document.getElementById('recordBtn').click()`);
    await waitForSelector(shop, '#grab-assistant-host', 8000);
    await sw.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({});
      const popupTab = tabs.find((tab) => tab.url && tab.url.includes('/popup/popup.html'));
      if (popupTab) await chrome.tabs.remove(popupTab.id);
      await chrome.tabs.update(${shopTab.id}, { active: true });
      return true;
    })()`);
    popup.close();
    popup = null;
    await shop.evaluate(`document.getElementById('payBtn').click()`);
    await sleep(700);
    const paymentAfterRecord = await shop.evaluate(`localStorage.getItem('paymentClicked')`);
    assert(!paymentAfterRecord, '录制时点击支付按钮不应触发支付');
    const toastText = await shop.evaluate(`document.getElementById('grab-assistant-host').shadowRoot.querySelector('.toast').textContent`);
    assert(toastText.includes('支付步骤'), `支付拦截提示不正确：${toastText}`);
    console.log('支付按钮拦截验证通过');

    await shop.evaluate(`document.getElementById('grab-assistant-host').shadowRoot.querySelector('[data-act="cancel"]').click()`);
    await sleep(400);

    console.log('\nE2E PASS');
    console.log(JSON.stringify({ orders: orders.length, runStatus: finalState.run.status, steps: state.steps.length }, null, 2));
  } finally {
    try {
      if (popup) popup.close();
      if (shop) shop.close();
      if (sw) sw.close();
    } catch (err) {
      /* ignore */
    }
    if (child && !child.killed) {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch (err) {
        child.kill();
      }
    }
  }
}

main().catch((err) => {
  console.error('E2E FAIL:', err.stack || err.message);
  process.exitCode = 1;
});
