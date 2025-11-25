const { remote } = require('webdriverio');

describe("/signin", () => {
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

it("Page loads: /signin", async () => {
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signin", async () => {
    // Navigate: /signin
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signin", async () => {
    // Navigate: /signin
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signin → /", async () => {
    // Navigate: /signin
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signin → /pricing", async () => {
    // Navigate: /signin
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signin → /contact", async () => {
    // Navigate: /signin
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signin → /signup", async () => {
    // Navigate: /signin
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Page loads: /signin", async () => {
    // Navigate: /signin#/?redirect=%2Fdashboard
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signin", async () => {
    // Navigate: /signin#/?redirect=%2Fdashboard
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signin", async () => {
    // Navigate: /signin#/?redirect=%2Fdashboard
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signin → /", async () => {
    // Navigate: /signin#/?redirect=%2Fdashboard
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signin → /pricing", async () => {
    // Navigate: /signin#/?redirect=%2Fdashboard
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signin → /contact", async () => {
    // Navigate: /signin#/?redirect=%2Fdashboard
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signin → /signup", async () => {
    // Navigate: /signin#/?redirect=%2Fdashboard
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Page loads: /signin", async () => {
    // Navigate: /signin#/?plan=free
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signin", async () => {
    // Navigate: /signin#/?plan=free
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signin", async () => {
    // Navigate: /signin#/?plan=free
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signin → /", async () => {
    // Navigate: /signin#/?plan=free
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signin → /pricing", async () => {
    // Navigate: /signin#/?plan=free
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signin → /contact", async () => {
    // Navigate: /signin#/?plan=free
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signin → /signup", async () => {
    // Navigate: /signin#/?plan=free
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Page loads: /signin", async () => {
    // Navigate: /signin#/?plan=pro
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signin", async () => {
    // Navigate: /signin#/?plan=pro
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signin", async () => {
    // Navigate: /signin#/?plan=pro
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signin → /", async () => {
    // Navigate: /signin#/?plan=pro
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signin → /pricing", async () => {
    // Navigate: /signin#/?plan=pro
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signin → /contact", async () => {
    // Navigate: /signin#/?plan=pro
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signin → /signup", async () => {
    // Navigate: /signin#/?plan=pro
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Page loads: /signin", async () => {
    // Navigate: /signin#/?plan=team
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signin", async () => {
    // Navigate: /signin#/?plan=team
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signin", async () => {
    // Navigate: /signin#/?plan=team
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signin → /", async () => {
    // Navigate: /signin#/?plan=team
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signin → /pricing", async () => {
    // Navigate: /signin#/?plan=team
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signin → /contact", async () => {
    // Navigate: /signin#/?plan=team
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signin → /signup", async () => {
    // Navigate: /signin#/?plan=team
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Page loads: /signin", async () => {
    // Navigate: /signin#/?redirect=%2Fagent
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signin", async () => {
    // Navigate: /signin#/?redirect=%2Fagent
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signin", async () => {
    // Navigate: /signin#/?redirect=%2Fagent
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signin → /", async () => {
    // Navigate: /signin#/?redirect=%2Fagent
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signin → /pricing", async () => {
    // Navigate: /signin#/?redirect=%2Fagent
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signin → /contact", async () => {
    // Navigate: /signin#/?redirect=%2Fagent
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signin → /signup", async () => {
    // Navigate: /signin#/?redirect=%2Fagent
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Page loads: /signin", async () => {
    // Navigate: /signin#/?redirect=%2Fintegrations
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signin", async () => {
    // Navigate: /signin#/?redirect=%2Fintegrations
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signin", async () => {
    // Navigate: /signin#/?redirect=%2Fintegrations
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signin → /", async () => {
    // Navigate: /signin#/?redirect=%2Fintegrations
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signin → /pricing", async () => {
    // Navigate: /signin#/?redirect=%2Fintegrations
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signin → /contact", async () => {
    // Navigate: /signin#/?redirect=%2Fintegrations
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signin → /signup", async () => {
    // Navigate: /signin#/?redirect=%2Fintegrations
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });

it("Page loads: /signin", async () => {
    // Navigate: /signin#/?redirect=%2Fsuite%2Fplaywright-ts
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signin", async () => {
    // Navigate: /signin#/?redirect=%2Fsuite%2Fplaywright-ts
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='identifier'], #identifier").setValue("Test value");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signin", async () => {
    // Navigate: /signin#/?redirect=%2Fsuite%2Fplaywright-ts
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signin → /", async () => {
    // Navigate: /signin#/?redirect=%2Fsuite%2Fplaywright-ts
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signin → /pricing", async () => {
    // Navigate: /signin#/?redirect=%2Fsuite%2Fplaywright-ts
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signin → /contact", async () => {
    // Navigate: /signin#/?redirect=%2Fsuite%2Fplaywright-ts
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signin → /signup", async () => {
    // Navigate: /signin#/?redirect=%2Fsuite%2Fplaywright-ts
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "signup")]`).waitForDisplayed();
  });
});
