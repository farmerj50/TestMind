// patchright, not playwright — shared by the two files (auth-session-stream.ts,
// live-security-session.ts) that both attach a patchright CDP session; must match their
// CDPSession type exactly since patchright's Protocol.CommandParameters isn't structurally
// identical to playwright-core's.
import type { CDPSession } from "patchright";

// Shared by auth-session-stream.ts (External Security Assessment auth capture) and live-security-session.ts
// (Live Security Testing) — both forward a remote browser's mouse/keyboard input into a
// server-side CDP session identically; extracted here so the two session types can't drift.

export const SPECIAL_KEYS: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  " ": { code: "Space", windowsVirtualKeyCode: 32 },
};

export async function dispatchMouseInput(cdp: CDPSession, msg: any): Promise<void> {
  const x = Number(msg.x) || 0;
  const y = Number(msg.y) || 0;
  if (msg.event === "move") {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  } else if (msg.event === "down") {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: msg.button || "left", clickCount: 1 });
  } else if (msg.event === "up") {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: msg.button || "left", clickCount: 1 });
  } else if (msg.event === "wheel") {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: Number(msg.deltaX) || 0,
      deltaY: Number(msg.deltaY) || 0,
    });
  }
}

export async function dispatchKeyInput(cdp: CDPSession, msg: any): Promise<void> {
  if (msg.event !== "down") return;
  const key = String(msg.key ?? "");
  if (key.length === 1) {
    // Dispatch a real keyDown/keyUp pair (with `text` set) rather than Input.insertText.
    // insertText bypasses keydown/keyup entirely, which behavioral bot-detection (and some
    // CSRF/anti-automation form handlers) can use to flag the submission as non-human even
    // though the field visually fills in correctly.
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: key, unmodifiedText: key, key });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key });
  } else {
    const mapped = SPECIAL_KEYS[key];
    if (mapped) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: mapped.code, windowsVirtualKeyCode: mapped.windowsVirtualKeyCode });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: mapped.code, windowsVirtualKeyCode: mapped.windowsVirtualKeyCode });
    }
  }
}
