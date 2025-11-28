# TestMind Recorder Desktop Helper (mabl-style)

This is a lightweight Electron helper that exposes a local HTTP endpoint to launch Playwright codegen on your machine so you can record flows directly from the web app.

## Why
Browsers cannot start local processes. To mimic mabl’s Trainer, run this helper locally; the Recorder page calls it to open Playwright codegen and save specs into `apps/api/testmind-generated/playwright-ts/recordings/<projectId>/`.

## Setup
1) Install deps:
   ```bash
   cd recorder-desktop
   npm install
   ```
2) Run the helper:
   ```bash
   npm start
   ```
   It listens on `http://localhost:43117/record`.

3) In the web app Recorder page:
   - Enter Base URL + Spec name (and Project ID to attach).
   - Click “Launch recorder”. The helper will open Playwright codegen and save to the recordings folder.

## Endpoint
- `POST http://localhost:43117/record`
  ```json
  { "baseUrl": "https://example.com/login", "name": "login.spec", "projectId": "my-project-id" }
  ```
  Launches Playwright codegen from `apps/web` and saves the spec to `apps/api/testmind-generated/playwright-ts/recordings/<projectId>/<name>.spec.ts`.

## Notes
- Requires Node and `npx` on PATH; Playwright should be installed (the helper uses `npx playwright codegen`).
- The Electron window stays hidden; the helper runs a local server and spawns codegen.
- You can change the port by setting `RECORDER_PORT` env before `npm start`.
