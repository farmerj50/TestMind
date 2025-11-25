const { remote } = require('webdriverio');

describe("/pricing", () => {
  let driver;

  before(async () => {
    driver = await remote({
      hostname: process.env.APPIUM_HOST || "127.0.0.1",
      port: Number(process.env.APPIUM_PORT || 4723),
      logLevel: "error",
      capabilities: {
        platformName: process.env.APPIUM_PLATFORM || "Android",
        "appium:deviceName": process.env.APPIUM_DEVICE || "Android Emulator",
        "appium:platformVersion": process.env.APPIUM_PLATFORM_VERSION || "12.0",
        "appium:app": process.env.APPIUM_APP || "",
        "appium:automationName": process.env.APPIUM_AUTOMATION || "UiAutomator2"
      }
    });
  });

  after(async () => {
    if (driver) await driver.deleteSession();
  });

it("Page loads: /pricing", async () => {
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Navigate /pricing → /", async () => {
    // Navigate: /pricing
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /pricing → /contact", async () => {
    // Navigate: /pricing
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /pricing → /signin", async () => {
    // Navigate: /pricing
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Navigate /pricing → /signup", async () => {
    // Navigate: /pricing
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Navigate /pricing → /dashboard", async () => {
    // Navigate: /pricing
    // Navigate: /dashboard
    await driver.$(`xpath=//*[contains(., "dashboard")]`).waitForDisplayed();
  });

it("Navigate /pricing → /agent", async () => {
    // Navigate: /pricing
    // Navigate: /agent
    await driver.$(`xpath=//*[contains(., "agent")]`).waitForDisplayed();
  });

it("Navigate /pricing → /integrations", async () => {
    // Navigate: /pricing
    // Navigate: /integrations
    await driver.$(`xpath=//*[contains(., "integrations")]`).waitForDisplayed();
  });

it("Navigate /pricing → /suite/playwright-ts", async () => {
    // Navigate: /pricing
    // Navigate: /suite/playwright-ts
    await driver.$(`xpath=//*[contains(., "playwright-ts")]`).waitForDisplayed();
  });
});
