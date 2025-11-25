const { remote } = require('webdriverio');

describe("/dashboard", () => {
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

it("Page loads: /dashboard", async () => {
    // Navigate: /dashboard
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /dashboard", async () => {
    // Navigate: /dashboard
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /dashboard", async () => {
    // Navigate: /dashboard
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /dashboard → /", async () => {
    // Navigate: /dashboard
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /dashboard → /pricing", async () => {
    // Navigate: /dashboard
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /dashboard → /contact", async () => {
    // Navigate: /dashboard
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /dashboard → /signin", async () => {
    // Navigate: /dashboard
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Navigate /dashboard → /signup", async () => {
    // Navigate: /dashboard
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });
});
