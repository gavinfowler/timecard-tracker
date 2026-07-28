// Tiny zero-dependency test harness. Collects cases, then reports to the DOM
// and to the console (so headless drivers can read window.__testResults).

const cases = [];

export function test(name, fn) {
  cases.push({ name, fn });
}

class AssertionError extends Error {}

export function assert(condition, message = 'expected truthy value') {
  if (!condition) throw new AssertionError(message);
}

export function assertEqual(actual, expected, message = '') {
  if (!Object.is(actual, expected)) {
    throw new AssertionError(
      `${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function assertClose(actual, expected, message = '', epsilon = 0.005) {
  if (!(Math.abs(actual - expected) < epsilon)) {
    throw new AssertionError(
      `${message ? `${message}: ` : ''}expected ~${expected}, got ${actual}`,
    );
  }
}

export function assertDeepEqual(actual, expected, message = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new AssertionError(`${message ? `${message}: ` : ''}expected ${b}, got ${a}`);
  }
}

export function run() {
  const results = cases.map(({ name, fn }) => {
    try {
      fn();
      return { name, ok: true, error: '' };
    } catch (err) {
      return { name, ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  globalThis.__testResults = { total: results.length, passed, failed, results };

  const summary = document.getElementById('summary');
  summary.textContent = `${passed} passed, ${failed} failed, ${results.length} total`;
  summary.className = failed === 0 ? 'ok' : 'fail';

  const list = document.getElementById('results');
  for (const result of results) {
    const item = document.createElement('li');
    item.className = result.ok ? 'ok' : 'fail';
    const name = document.createElement('span');
    name.textContent = `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`;
    item.append(name);
    if (!result.ok) {
      const detail = document.createElement('pre');
      detail.textContent = result.error;
      item.append(detail);
    }
    list.append(item);
  }

  document.title = failed === 0 ? `PASS (${passed})` : `FAIL (${failed})`;
  console.log(`${passed} passed, ${failed} failed`);
  for (const result of results.filter((r) => !r.ok)) {
    console.error(`FAIL ${result.name}: ${result.error}`);
  }
}
