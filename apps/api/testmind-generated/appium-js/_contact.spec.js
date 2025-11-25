const { remote } = require('webdriverio');

describe("/contact", () => {
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

it("Page loads: /contact", async () => {
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Navigate /contact → /", async () => {
    // Navigate: /contact
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /contact → /pricing", async () => {
    // Navigate: /contact
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /contact → /signin", async () => {
    // Navigate: /contact
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Navigate /contact → /signup", async () => {
    // Navigate: /contact
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Navigate /contact → /dashboard", async () => {
    // Navigate: /contact
    // Navigate: /dashboard
    await driver.$(`xpath=//*[contains(., "dashboard")]`).waitForDisplayed();
  });

it("Navigate /contact → /agent", async () => {
    // Navigate: /contact
    // Navigate: /agent
    await driver.$(`xpath=//*[contains(., "agent")]`).waitForDisplayed();
  });

it("Navigate /contact → /integrations", async () => {
    // Navigate: /contact
    // Navigate: /integrations
    await driver.$(`xpath=//*[contains(., "integrations")]`).waitForDisplayed();
  });

it("Navigate /contact → /suite/playwright-ts", async () => {
    // Navigate: /contact
    // Navigate: /suite/playwright-ts
    await driver.$(`xpath=//*[contains(., "playwright-ts")]`).waitForDisplayed();
  });
});
