import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const U = require('../extension/shared/utils.js');

test('normalizeText 合并空白', () => {
  assert.equal(U.normalizeText('  提交\n\n订单  '), '提交 订单');
  assert.equal(U.normalizeText(null), '');
});

test('compactText 去掉分隔符并转小写', () => {
  assert.equal(U.compactText('提交 / 订单'), '提交订单');
  assert.equal(U.compactText('Pay Now'), 'paynow');
});

test('支付/提交/跳转判断', () => {
  assert.equal(U.isPaymentText('去支付'), true);
  assert.equal(U.isPaymentText('立即支付'), true);
  assert.equal(U.isPaymentText('提交订单'), false);
  assert.equal(U.isSubmitText('提交订单'), true);
  assert.equal(U.isSubmitText('确认下单'), true);
  assert.equal(U.isSubmitText('立即购买'), false);
  assert.equal(U.looksLikeNavigation('立即购买'), true);
  assert.equal(U.looksLikeNavigation('去结算'), true);
});

test('服务器时间换算成本机时间', () => {
  assert.equal(U.computeTargetLocal(100000, 0), 100000);
  // 本机比服务器慢 2 秒：服务器 20:00 时本机是 19:59:58
  assert.equal(U.computeTargetLocal(100000, 2000), 98000);
  // 本机比服务器快 2 秒：服务器 20:00 时本机是 20:00:02
  assert.equal(U.computeTargetLocal(100000, -2000), 102000);
});

test('datetime-local 往返保留毫秒', () => {
  const value = '2026-10-29T20:00:00.500';
  const parsed = U.parseTargetTime(value);
  assert.equal(Number.isFinite(parsed), true);
  assert.equal(U.toDateTimeLocalValue(parsed), value);
});

test('非法时间返回 NaN', () => {
  assert.equal(Number.isNaN(U.parseTargetTime('')), true);
  assert.equal(Number.isNaN(U.parseTargetTime('not-a-date')), true);
});

test('倒计时格式固定', () => {
  assert.equal(U.formatCountdown(0), '00:00:00.000');
  assert.equal(U.formatCountdown(3661001), '01:01:01.001');
  assert.equal(U.formatCountdown(86400000 + 5000), '24:00:05.000');
});

test('步骤归一化限制延迟并保留选择器', () => {
  const step = U.normalizeStep({
    action: 'click',
    selector: '#buy',
    text: '  立即购买  ',
    delayAfter: 99999,
    tag: 'BUTTON'
  });
  assert.equal(step.action, 'click');
  assert.equal(step.selector, '#buy');
  assert.equal(step.text, '立即购买');
  assert.equal(step.delayAfter, 10000);
  assert.equal(step.tag, 'button');
});

test('输入步骤保留值', () => {
  const step = U.normalizeStep({ action: 'input', value: 'ABC-123', selector: 'input[name=code]' });
  assert.equal(step.action, 'input');
  assert.equal(step.value, 'ABC-123');
});

test('设置归一化与默认值', () => {
  const defaults = U.normalizeSettings();
  assert.equal(defaults.stepTimeoutMs, 12000);
  assert.equal(defaults.recordInputs, false);
  const custom = U.normalizeSettings({
    stepTimeoutMs: 500,
    delayAfterMs: 99999,
    refreshBeforeRun: true,
    recordInputs: true
  });
  assert.equal(custom.stepTimeoutMs, 1000);
  assert.equal(custom.delayAfterMs, 5000);
  assert.equal(custom.refreshBeforeRun, true);
  assert.equal(custom.recordInputs, true);
});

test('步骤摘要可用于错误提示', () => {
  assert.match(U.summarizeStep({ action: 'click', text: '提交订单' }), /提交订单/);
  assert.match(U.summarizeStep({ action: 'input', placeholder: '优惠码' }), /优惠码/);
});
