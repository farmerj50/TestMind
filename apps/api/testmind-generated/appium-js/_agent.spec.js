const { remote } = require('webdriverio');

describe("/agent", () => {
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

it("Page loads: /agent", async () => {
    // Navigate: /agent
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /agent", async () => {
    // Navigate: /agent
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /agent", async () => {
    // Navigate: /agent
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /agent → /", async () => {
    // Navigate: /agent
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /agent → /pricing", async () => {
    // Navigate: /agent
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /agent → /contact", async () => {
    // Navigate: /agent
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /agent → /signin", async () => {
    // Navigate: /agent
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Navigate /agent → /signup", async () => {
    // Navigate: /agent
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });
});
