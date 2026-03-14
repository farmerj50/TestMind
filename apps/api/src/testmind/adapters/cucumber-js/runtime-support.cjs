const { setDefaultTimeout } = require('@cucumber/cucumber');

const timeoutMs = Number(process.env.TM_CUCUMBER_STEP_TIMEOUT_MS ?? '30000');
if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
  setDefaultTimeout(timeoutMs);
}
