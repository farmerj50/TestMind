/// <reference types="node" />
import type { PlaywrightTestConfig } from '@playwright/test';
const config: PlaywrightTestConfig = {
  use: {
    baseURL: process.env.TM_BASE_URL || "https://www.justicepathlaw.com",
  },
};
export default config;
