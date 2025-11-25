const { remote } = require('webdriverio');

describe("/", () => {
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

it("Page loads: /", async () => {
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Navigate / → /pricing", async () => {
    // Navigate: /
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate / → /contact", async () => {
    // Navigate: /
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate / → /signin", async () => {
    // Navigate: /
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Navigate / → /signup", async () => {
    // Navigate: /
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Navigate / → /dashboard", async () => {
    // Navigate: /
    // Navigate: /dashboard
    await driver.$(`xpath=//*[contains(., "dashboard")]`).waitForDisplayed();
  });

it("Navigate / → /agent", async () => {
    // Navigate: /
    // Navigate: /agent
    await driver.$(`xpath=//*[contains(., "agent")]`).waitForDisplayed();
  });

it("Navigate / → /integrations", async () => {
    // Navigate: /
    // Navigate: /integrations
    await driver.$(`xpath=//*[contains(., "integrations")]`).waitForDisplayed();
  });

it("Navigate / → /suite/playwright-ts", async () => {
    // Navigate: /
    // Navigate: /suite/playwright-ts
    await driver.$(`xpath=//*[contains(., "playwright-ts")]`).waitForDisplayed();
  });

it("Page loads: /", async () => {
    // Navigate: /#features
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Navigate / → /pricing", async () => {
    // Navigate: /#features
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate / → /contact", async () => {
    // Navigate: /#features
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate / → /signin", async () => {
    // Navigate: /#features
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Navigate / → /signup", async () => {
    // Navigate: /#features
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Navigate / → /dashboard", async () => {
    // Navigate: /#features
    // Navigate: /dashboard
    await driver.$(`xpath=//*[contains(., "dashboard")]`).waitForDisplayed();
  });

it("Navigate / → /agent", async () => {
    // Navigate: /#features
    // Navigate: /agent
    await driver.$(`xpath=//*[contains(., "agent")]`).waitForDisplayed();
  });

it("Navigate / → /integrations", async () => {
    // Navigate: /#features
    // Navigate: /integrations
    await driver.$(`xpath=//*[contains(., "integrations")]`).waitForDisplayed();
  });

it("Navigate / → /suite/playwright-ts", async () => {
    // Navigate: /#features
    // Navigate: /suite/playwright-ts
    await driver.$(`xpath=//*[contains(., "playwright-ts")]`).waitForDisplayed();
  });

it("Page loads: /", async () => {
    // Navigate: /#how
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Navigate / → /pricing", async () => {
    // Navigate: /#how
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate / → /contact", async () => {
    // Navigate: /#how
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate / → /signin", async () => {
    // Navigate: /#how
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Navigate / → /signup", async () => {
    // Navigate: /#how
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Navigate / → /dashboard", async () => {
    // Navigate: /#how
    // Navigate: /dashboard
    await driver.$(`xpath=//*[contains(., "dashboard")]`).waitForDisplayed();
  });

it("Navigate / → /agent", async () => {
    // Navigate: /#how
    // Navigate: /agent
    await driver.$(`xpath=//*[contains(., "agent")]`).waitForDisplayed();
  });

it("Navigate / → /integrations", async () => {
    // Navigate: /#how
    // Navigate: /integrations
    await driver.$(`xpath=//*[contains(., "integrations")]`).waitForDisplayed();
  });

it("Navigate / → /suite/playwright-ts", async () => {
    // Navigate: /#how
    // Navigate: /suite/playwright-ts
    await driver.$(`xpath=//*[contains(., "playwright-ts")]`).waitForDisplayed();
  });

it("Page loads: /", async () => {
    // Navigate: /#pricing
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Navigate / → /pricing", async () => {
    // Navigate: /#pricing
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate / → /contact", async () => {
    // Navigate: /#pricing
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate / → /signin", async () => {
    // Navigate: /#pricing
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Navigate / → /signup", async () => {
    // Navigate: /#pricing
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Navigate / → /dashboard", async () => {
    // Navigate: /#pricing
    // Navigate: /dashboard
    await driver.$(`xpath=//*[contains(., "dashboard")]`).waitForDisplayed();
  });

it("Navigate / → /agent", async () => {
    // Navigate: /#pricing
    // Navigate: /agent
    await driver.$(`xpath=//*[contains(., "agent")]`).waitForDisplayed();
  });

it("Navigate / → /integrations", async () => {
    // Navigate: /#pricing
    // Navigate: /integrations
    await driver.$(`xpath=//*[contains(., "integrations")]`).waitForDisplayed();
  });

it("Navigate / → /suite/playwright-ts", async () => {
    // Navigate: /#pricing
    // Navigate: /suite/playwright-ts
    await driver.$(`xpath=//*[contains(., "playwright-ts")]`).waitForDisplayed();
  });

it("Page loads: /", async () => {
    // Navigate: /#faq
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Navigate / → /pricing", async () => {
    // Navigate: /#faq
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate / → /contact", async () => {
    // Navigate: /#faq
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate / → /signin", async () => {
    // Navigate: /#faq
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Navigate / → /signup", async () => {
    // Navigate: /#faq
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Navigate / → /dashboard", async () => {
    // Navigate: /#faq
    // Navigate: /dashboard
    await driver.$(`xpath=//*[contains(., "dashboard")]`).waitForDisplayed();
  });

it("Navigate / → /agent", async () => {
    // Navigate: /#faq
    // Navigate: /agent
    await driver.$(`xpath=//*[contains(., "agent")]`).waitForDisplayed();
  });

it("Navigate / → /integrations", async () => {
    // Navigate: /#faq
    // Navigate: /integrations
    await driver.$(`xpath=//*[contains(., "integrations")]`).waitForDisplayed();
  });

it("Navigate / → /suite/playwright-ts", async () => {
    // Navigate: /#faq
    // Navigate: /suite/playwright-ts
    await driver.$(`xpath=//*[contains(., "playwright-ts")]`).waitForDisplayed();
  });

it("Page loads: /", async () => {
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Navigate / → /pricing", async () => {
    // Navigate: /
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate / → /contact", async () => {
    // Navigate: /
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate / → /signin", async () => {
    // Navigate: /
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Navigate / → /signup", async () => {
    // Navigate: /
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Navigate / → /dashboard", async () => {
    // Navigate: /
    // Navigate: /dashboard
    await driver.$(`xpath=//*[contains(., "dashboard")]`).waitForDisplayed();
  });

it("Navigate / → /agent", async () => {
    // Navigate: /
    // Navigate: /agent
    await driver.$(`xpath=//*[contains(., "agent")]`).waitForDisplayed();
  });

it("Navigate / → /integrations", async () => {
    // Navigate: /
    // Navigate: /integrations
    await driver.$(`xpath=//*[contains(., "integrations")]`).waitForDisplayed();
  });

it("Navigate / → /suite/playwright-ts", async () => {
    // Navigate: /
    // Navigate: /suite/playwright-ts
    await driver.$(`xpath=//*[contains(., "playwright-ts")]`).waitForDisplayed();
  });
});
