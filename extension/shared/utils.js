/*
 * 抢单助手 - 共享工具
 * 同时运行在：扩展弹窗、后台 Service Worker、内容脚本、Node 单元测试。
 * 不依赖任何第三方库。
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.GrabUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function (root) {
  'use strict';

  const VERSION = '0.1.0';
  const MAX_STEPS = 50;
  const MAX_TARGET_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
  const MIN_TARGET_AHEAD_MS = 1200;

  const RUN_STATUS = Object.freeze({
    ARMED: 'armed',
    PREPARING: 'preparing',
    RUNNING: 'running',
    PAUSED: 'paused',
    DONE: 'done',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
  });

  const DEFAULT_SETTINGS = Object.freeze({
    stepTimeoutMs: 12000,
    delayAfterMs: 180,
    refreshBeforeRun: false,
    returnToStart: true,
    focusWindow: true,
    notify: true,
    checkChallenge: true,
    recordInputs: false
  });

  /* ------------------------------------------------------------------ *
   * 文本与判断
   * ------------------------------------------------------------------ */

  const RE_PAYMENT =
    /(立即支付|去支付|确认支付|支付订单|支付货款|付款|收银台|扫码支付|余额支付|花呗支付|pay\s*now|confirm\s*payment|make\s*payment)/i;
  const RE_SUBMIT =
    /(提交订单|确认下单|立即下单|提交购买|确认购买|结算并提交|place\s*order|submit\s*order|confirm\s*order)/i;
  const RE_NAVIGATE =
    /(立即购买|去结算|结算|抢购|立即抢|选座|确认选择|下一步|继续|去下单|马上抢|提交订单|确认下单|立即下单)/i;

  function normalizeText(value) {
    return String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function compactText(value) {
    return normalizeText(value)
      .replace(/[\s·•|/\\（）()【】\[\]<>《》「」]+/g, '')
      .toLowerCase();
  }

  function textOf(el) {
    if (!el) return '';
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      return normalizeText(
        el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          el.value ||
          el.getAttribute('title') ||
          ''
      ).slice(0, 120);
    }
    if (tag === 'img') return normalizeText(el.getAttribute('alt') || '').slice(0, 120);
    return normalizeText(el.innerText || el.textContent || '').slice(0, 160);
  }

  function accessibleName(el) {
    if (!el) return '';
    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => {
          const node = el.ownerDocument && el.ownerDocument.getElementById(id);
          return node ? textOf(node) : '';
        })
        .filter(Boolean);
      if (parts.length) return normalizeText(parts.join(' '));
    }
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return normalizeText(aria);
    const text = textOf(el);
    if (text) return text;
    if (el.getAttribute) {
      return normalizeText(
        el.getAttribute('title') ||
          el.getAttribute('alt') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('name') ||
          ''
      );
    }
    return '';
  }

  function isPaymentText(text) {
    return RE_PAYMENT.test(String(text || ''));
  }

  function isSubmitText(text) {
    return RE_SUBMIT.test(String(text || ''));
  }

  function looksLikeNavigation(text) {
    return RE_NAVIGATE.test(String(text || ''));
  }

  function isDangerousRecordText(text) {
    return isPaymentText(text) || isSubmitText(text);
  }

  /* ------------------------------------------------------------------ *
   * 时间
   * ------------------------------------------------------------------ */

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function pad(value, length) {
    return String(Math.abs(Math.trunc(value))).padStart(length || 2, '0');
  }

  function formatClock(epochMs, withMs) {
    if (!Number.isFinite(epochMs)) return '--:--:--';
    const d = new Date(epochMs);
    const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
  }

  function formatDateTime(epochMs) {
    if (!Number.isFinite(epochMs)) return '--';
    const d = new Date(epochMs);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatClock(epochMs, false)}`;
  }

  function formatCountdown(ms) {
    const total = Math.max(0, Math.floor(Number(ms) || 0));
    const day = Math.floor(total / 86400000);
    const hour = Math.floor((total % 86400000) / 3600000);
    const minute = Math.floor((total % 3600000) / 60000);
    const second = Math.floor((total % 60000) / 1000);
    const milli = total % 1000;
    const clock = `${pad(hour + day * 24)}:${pad(minute)}:${pad(second)}.${pad(milli, 3)}`;
    return clock;
  }

  function formatRelative(ms) {
    const abs = Math.abs(ms);
    if (abs < 1000) return `${Math.round(abs)} 毫秒`;
    if (abs < 60000) return `${(abs / 1000).toFixed(abs < 10000 ? 1 : 0)} 秒`;
    if (abs < 3600000) return `${(abs / 60000).toFixed(1)} 分钟`;
    return `${(abs / 3600000).toFixed(1)} 小时`;
  }

  function parseTargetTime(value) {
    if (value == null || value === '') return NaN;
    if (typeof value === 'number') return value;
    // datetime-local 的字符串按本地时间解析
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function toDateTimeLocalValue(epochMs) {
    if (!Number.isFinite(epochMs)) return '';
    const d = new Date(epochMs);
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    );
  }

  /**
   * offsetMs = 服务器时间 - 本机时间。
   * 用户填写的目标时间按“服务器时间”理解；换算成本机时间执行。
   */
  function computeTargetLocal(targetServerEpoch, offsetMs) {
    return Number(targetServerEpoch) - (Number(offsetMs) || 0);
  }

  function nowServer(offsetMs) {
    return Date.now() + (Number(offsetMs) || 0);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  function uid() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /* ------------------------------------------------------------------ *
   * DOM 可见性 / 可点击性
   * ------------------------------------------------------------------ */

  function isVisible(el) {
    if (!el || !el.isConnected || el.nodeType !== 1) return false;
    if (typeof el.getClientRects !== 'function') return false;
    if (el.getClientRects().length === 0) return false;
    const style = root.getComputedStyle ? root.getComputedStyle(el) : null;
    if (!style) return true;
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false;
    }
    if (Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  }

  function isDisabled(el) {
    if (!el) return true;
    if ('disabled' in el && el.disabled) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/(^|[\s_-])(is-)?disabled($|[\s_-])/i.test(cls)) return true;
    return false;
  }

  function isEditable(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color'].includes(type);
    }
    return !!el.isContentEditable;
  }

  function isClickable(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (['button', 'a', 'label', 'summary'].includes(tag)) return true;
    if (tag === 'input') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      return ['button', 'submit', 'reset', 'image', 'checkbox', 'radio'].includes(type);
    }
    if (el.getAttribute && (el.getAttribute('role') === 'button' || el.hasAttribute('onclick'))) return true;
    if (el.hasAttribute && el.hasAttribute('tabindex')) return true;
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 选择器
   * ------------------------------------------------------------------ */

  function cssEscape(value) {
    const str = String(value == null ? '' : value);
    if (root.CSS && typeof root.CSS.escape === 'function') return root.CSS.escape(str);
    return str.replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, (ch) => `\\${ch}`);
  }

  function escapeAttr(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\a ');
  }

  function isUniqueSelector(selector, doc) {
    if (!selector) return false;
    const scope = doc || root.document;
    if (!scope || !scope.querySelectorAll) return false;
    try {
      return scope.querySelectorAll(selector).length === 1;
    } catch (err) {
      return false;
    }
  }

  function stableClasses(el) {
    if (!el.classList) return [];
    return Array.from(el.classList)
      .filter((name) => {
        if (!name || name.length > 40) return false;
        if (/^(active|selected|disabled|hover|focus|open|show|hide|visible|current|checked|loading|focused)$/i.test(name)) {
          return false;
        }
        if (/^(_|css|sc|jsx|svelte|emotion|styled)-?[a-z0-9]{3,}$/i.test(name)) return false;
        if (/[a-f0-9]{6,}/i.test(name) && /\d/.test(name)) return false;
        if (/\d{3,}/.test(name)) return false;
        return true;
      })
      .slice(0, 2);
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    const doc = el.ownerDocument || root.document;

    if (el.id) {
      const idSel = `#${cssEscape(el.id)}`;
      if (isUniqueSelector(idSel, doc)) return idSel;
    }

    const attrs = [
      'data-testid',
      'data-test-id',
      'data-test',
      'data-qa',
      'data-cy',
      'name',
      'aria-label',
      'placeholder',
      'title',
      'alt'
    ];
    const tag = el.tagName.toLowerCase();
    for (const attr of attrs) {
      const value = el.getAttribute(attr);
      if (!value || value.length > 80) continue;
      const sel = `${tag}[${attr}="${escapeAttr(value)}"]`;
      if (isUniqueSelector(sel, doc)) return sel;
    }

    if (tag === 'a' && el.getAttribute('href')) {
      const href = el.getAttribute('href');
      if (href && href.length < 120) {
        const sel = `a[href="${escapeAttr(href)}"]`;
        if (isUniqueSelector(sel, doc)) return sel;
      }
    }

    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth += 1) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += `#${cssEscape(node.id)}`;
        parts.unshift(part);
        const selWithId = parts.join(' > ');
        if (isUniqueSelector(selWithId, doc)) return selWithId;
      } else {
        const classes = stableClasses(node);
        if (classes.length) part += `.${classes.map(cssEscape).join('.')}`;
        const parent = node.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        const sel = parts.join(' > ');
        if (isUniqueSelector(sel, doc)) return sel;
      }
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function describeElement(el) {
    if (!el) return {};
    const tag = (el.tagName || '').toLowerCase();
    return {
      tag,
      text: normalizeText(accessibleName(el)).slice(0, 80),
      ariaLabel: normalizeText(el.getAttribute && el.getAttribute('aria-label')).slice(0, 80),
      name: normalizeText(el.getAttribute && el.getAttribute('name')).slice(0, 80),
      placeholder: normalizeText(el.getAttribute && el.getAttribute('placeholder')).slice(0, 80),
      type: normalizeText(el.getAttribute && el.getAttribute('type')).slice(0, 30),
      href: (el.href || '').slice(0, 200),
      role: normalizeText(el.getAttribute && el.getAttribute('role')).slice(0, 40)
    };
  }

  function elementScore(el, step) {
    let score = 0;
    if (isVisible(el)) score += 30;
    if (!isDisabled(el)) score += 8;
    const tag = (el.tagName || '').toLowerCase();
    if (step.tag && tag === step.tag) score += 20;
    const text = compactText(accessibleName(el));
    const target = compactText(step.text || step.ariaLabel || '');
    if (target) {
      if (text === target) score += 60;
      else if (text.startsWith(target)) score += 42;
      else if (text.includes(target) && target.length >= 2) score += 24;
      else score -= 12;
    }
    const aria = compactText(el.getAttribute && el.getAttribute('aria-label'));
    const ariaTarget = compactText(step.ariaLabel);
    if (ariaTarget && aria === ariaTarget) score += 26;
    const name = compactText(el.getAttribute && el.getAttribute('name'));
    const nameTarget = compactText(step.name);
    if (nameTarget && name === nameTarget) score += 16;
    const placeholder = compactText(el.getAttribute && el.getAttribute('placeholder'));
    const phTarget = compactText(step.placeholder);
    if (phTarget && placeholder === phTarget) score += 20;
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    const area = Math.max(1, rect.width * rect.height);
    score += clamp(12 - Math.log10(area) * 2, 0, 12);
    return score;
  }

  function collectTextCandidates(doc, step) {
    const tags = 'button,a,input,label,summary,[role="button"],[onclick],[tabindex]';
    let nodes = [];
    try {
      nodes = Array.from(doc.querySelectorAll(tags));
    } catch (err) {
      nodes = [];
    }
    // 兼容用 div/span 做按钮的站点
    if (step.tag === 'div' || step.tag === 'span') {
      try {
        nodes = nodes.concat(Array.from(doc.querySelectorAll(step.tag)));
      } catch (err) {
        /* ignore */
      }
    }
    return nodes;
  }

  function findElement(step, doc) {
    if (!step) return null;
    const scope = doc || root.document;
    if (!scope) return null;

    let selectorMatch = null;
    if (step.selector) {
      try {
        const nodes = Array.from(scope.querySelectorAll(step.selector));
        let best = null;
        let bestScore = -Infinity;
        for (const node of nodes) {
          const score = elementScore(node, step);
          if (score > bestScore) {
            best = node;
            bestScore = score;
          }
        }
        if (best && isVisible(best)) selectorMatch = best;
      } catch (err) {
        /* 选择器失效，走文本兜底 */
      }
    }
    if (selectorMatch) return selectorMatch;

    const targetText = compactText(step.text || step.ariaLabel || '');
    const targetAria = compactText(step.ariaLabel || '');
    const targetName = compactText(step.name || '');
    const targetPlaceholder = compactText(step.placeholder || '');
    if (!targetText && !targetAria && !targetName && !targetPlaceholder) return null;

    const candidates = collectTextCandidates(scope, step);
    let best = null;
    let bestScore = -Infinity;
    for (const node of candidates) {
      if (!isVisible(node)) continue;
      const text = compactText(accessibleName(node));
      const aria = compactText(node.getAttribute && node.getAttribute('aria-label'));
      const name = compactText(node.getAttribute && node.getAttribute('name'));
      const placeholder = compactText(node.getAttribute && node.getAttribute('placeholder'));
      let relevant = false;
      if (targetText && (text === targetText || text.startsWith(targetText) || (targetText.length >= 2 && text.includes(targetText)))) {
        relevant = true;
      }
      if (!relevant && targetAria && aria === targetAria) relevant = true;
      if (!relevant && targetName && name === targetName) relevant = true;
      if (!relevant && targetPlaceholder && placeholder === targetPlaceholder) relevant = true;
      if (!relevant) continue;
      const score = elementScore(node, step);
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * 页面状态
   * ------------------------------------------------------------------ */

  function detectChallenge(doc) {
    const scope = doc || root.document;
    if (!scope) return null;
    const selectors = [
      'iframe[src*="captcha" i]',
      'iframe[src*="verify" i]',
      'iframe[src*="geetest" i]',
      '[id*="captcha" i]',
      '[class*="captcha" i]',
      '.nc-container',
      '.nc_wrapper',
      '.geetest_panel',
      '.geetest_holder',
      '[class*="slider-verify" i]',
      '[class*="slide-verify" i]',
      '[class*="verify-bar" i]',
      '[class*="captcha-box" i]',
      '[class*="secsdk" i]'
    ];
    for (const sel of selectors) {
      let nodes = [];
      try {
        nodes = Array.from(scope.querySelectorAll(sel));
      } catch (err) {
        nodes = [];
      }
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 16) continue;
        return { type: 'captcha', reason: '页面出现验证码或滑块验证，需要你手动完成' };
      }
    }
    const bodyText = normalizeText((scope.body && scope.body.innerText) || '').slice(0, 30000);
    if (/(请完成安全验证|请拖动滑块|拖动滑块完成|滑动验证|请依次点击|请完成验证)/.test(bodyText)) {
      return { type: 'captcha', reason: '页面提示需要安全验证，请手动完成后继续' };
    }
    return null;
  }

  function detectQueue(doc) {
    const scope = doc || root.document;
    if (!scope) return null;
    const bodyText = normalizeText((scope.body && scope.body.innerText) || '').slice(0, 30000);
    const match = bodyText.match(/(排队中|正在排队|前方还有\s*\d+\s*人|请耐心等待)/);
    return match ? match[1] : null;
  }

  function applyInputValue(el, value) {
    if (!el) return false;
    const doc = el.ownerDocument || root.document;
    const tag = (el.tagName || '').toLowerCase();
    el.focus({ preventScroll: false });
    if (tag === 'select') {
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const proto = tag === 'textarea' ? root.HTMLTextAreaElement.prototype : root.HTMLInputElement.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function clickElement(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    } catch (err) {
      /* ignore */
    }
    try {
      el.focus({ preventScroll: true });
    } catch (err) {
      /* ignore */
    }
    el.click();
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 存储默认值
   * ------------------------------------------------------------------ */

  function normalizeSettings(input) {
    const source = input && typeof input === 'object' ? input : {};
    const settings = { ...DEFAULT_SETTINGS };
    if (Number.isFinite(Number(source.stepTimeoutMs))) {
      settings.stepTimeoutMs = clamp(Number(source.stepTimeoutMs), 1000, 120000);
    }
    if (Number.isFinite(Number(source.delayAfterMs))) {
      settings.delayAfterMs = clamp(Number(source.delayAfterMs), 0, 5000);
    }
    for (const key of ['refreshBeforeRun', 'returnToStart', 'focusWindow', 'notify', 'checkChallenge', 'recordInputs']) {
      if (typeof source[key] === 'boolean') settings[key] = source[key];
    }
    return settings;
  }

  function normalizeStep(input, index) {
    const source = input && typeof input === 'object' ? input : {};
    const action = source.action === 'input' ? 'input' : 'click';
    const step = {
      id: String(source.id || `step-${Date.now()}-${index || 0}`),
      action,
      selector: String(source.selector || ''),
      tag: String(source.tag || '').toLowerCase(),
      text: normalizeText(source.text || '').slice(0, 160),
      ariaLabel: normalizeText(source.ariaLabel || '').slice(0, 120),
      name: normalizeText(source.name || '').slice(0, 120),
      placeholder: normalizeText(source.placeholder || '').slice(0, 120),
      type: normalizeText(source.type || '').slice(0, 30),
      href: String(source.href || '').slice(0, 300),
      value: typeof source.value === 'string' ? source.value : '',
      url: String(source.url || '').slice(0, 1000),
      delayAfter: clamp(Number(source.delayAfter) || 0, 0, 10000)
    };
    return step;
  }

  function summarizeStep(step) {
    if (!step) return '';
    if (step.action === 'input') {
      return `在「${step.placeholder || step.ariaLabel || step.name || step.selector}」输入内容`;
    }
    return step.text || step.ariaLabel || step.placeholder || step.selector || '点击元素';
  }

  return {
    VERSION,
    MAX_STEPS,
    MAX_TARGET_AHEAD_MS,
    MIN_TARGET_AHEAD_MS,
    RUN_STATUS,
    DEFAULT_SETTINGS,
    normalizeText,
    compactText,
    textOf,
    accessibleName,
    isPaymentText,
    isSubmitText,
    looksLikeNavigation,
    isDangerousRecordText,
    clamp,
    pad,
    formatClock,
    formatDateTime,
    formatCountdown,
    formatRelative,
    parseTargetTime,
    toDateTimeLocalValue,
    computeTargetLocal,
    nowServer,
    sleep,
    uid,
    isVisible,
    isDisabled,
    isEditable,
    isClickable,
    cssEscape,
    escapeAttr,
    isUniqueSelector,
    stableClasses,
    buildSelector,
    describeElement,
    findElement,
    detectChallenge,
    detectQueue,
    applyInputValue,
    clickElement,
    normalizeSettings,
    normalizeStep,
    summarizeStep
  };
});
