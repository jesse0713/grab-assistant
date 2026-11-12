export class CDP {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  static async connect(url) {
    const client = new CDP(url);
    await client.open();
    return client;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${this.url}`)), 8000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP connect error: ${event.message || this.url}`));
      };
      ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (err) {
          return;
        }
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
          else pending.resolve(message.result);
          return;
        }
        if (message.method) {
          const handlers = this.listeners.get(message.method) || [];
          for (const handler of handlers) handler(message.params);
        }
      };
    });
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP socket is not open'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP command timeout: ${method}`));
        }
      }, 30000);
    });
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) || [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
    return () => {
      const next = (this.listeners.get(method) || []).filter((item) => item !== handler);
      this.listeners.set(method, next);
    };
  }

  async evaluate(expression, options = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise !== false,
      returnByValue: true,
      userGesture: options.userGesture !== false,
      ...options
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`Evaluation failed: ${detail}`);
    }
    return result.result ? result.result.value : undefined;
  }

  close() {
    try {
      this.ws?.close();
    } catch (err) {
      /* ignore */
    }
  }
}

export const CDP_BASE = process.env.CDP_BASE || 'http://127.0.0.1:18080';

export async function listTargets() {
  const response = await fetch(`${CDP_BASE}/json/list`);
  return response.json();
}

export async function waitForTarget(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets();
    const found = targets.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}
