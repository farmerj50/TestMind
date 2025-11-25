const { remote } = require('webdriverio');

describe("/signup", () => {
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

it("Page loads: /signup", async () => {
    // Navigate: /signup
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signup", async () => {
    // Navigate: /signup
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signup", async () => {
    // Navigate: /signup
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signup → /", async () => {
    // Navigate: /signup
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signup → /pricing", async () => {
    // Navigate: /signup
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signup → /contact", async () => {
    // Navigate: /signup
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signup → /signin", async () => {
    // Navigate: /signup
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Page loads: /signup", async () => {
    // Navigate: /signup#/?redirect=%2Fdashboard
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signup", async () => {
    // Navigate: /signup#/?redirect=%2Fdashboard
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signup", async () => {
    // Navigate: /signup#/?redirect=%2Fdashboard
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signup → /", async () => {
    // Navigate: /signup#/?redirect=%2Fdashboard
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signup → /pricing", async () => {
    // Navigate: /signup#/?redirect=%2Fdashboard
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signup → /contact", async () => {
    // Navigate: /signup#/?redirect=%2Fdashboard
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signup → /signin", async () => {
    // Navigate: /signup#/?redirect=%2Fdashboard
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Page loads: /signup", async () => {
    // Navigate: /signup?plan=free
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signup", async () => {
    // Navigate: /signup?plan=free
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signup", async () => {
    // Navigate: /signup?plan=free
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signup → /", async () => {
    // Navigate: /signup?plan=free
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signup → /pricing", async () => {
    // Navigate: /signup?plan=free
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signup → /contact", async () => {
    // Navigate: /signup?plan=free
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signup → /signin", async () => {
    // Navigate: /signup?plan=free
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Page loads: /signup", async () => {
    // Navigate: /signup?plan=pro
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signup", async () => {
    // Navigate: /signup?plan=pro
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signup", async () => {
    // Navigate: /signup?plan=pro
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signup → /", async () => {
    // Navigate: /signup?plan=pro
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signup → /pricing", async () => {
    // Navigate: /signup?plan=pro
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signup → /contact", async () => {
    // Navigate: /signup?plan=pro
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signup → /signin", async () => {
    // Navigate: /signup?plan=pro
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Page loads: /signup", async () => {
    // Navigate: /signup?plan=team
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signup", async () => {
    // Navigate: /signup?plan=team
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signup", async () => {
    // Navigate: /signup?plan=team
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signup → /", async () => {
    // Navigate: /signup?plan=team
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signup → /pricing", async () => {
    // Navigate: /signup?plan=team
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signup → /contact", async () => {
    // Navigate: /signup?plan=team
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signup → /signin", async () => {
    // Navigate: /signup?plan=team
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Page loads: /signup", async () => {
    // Navigate: /signup#/?redirect=%2Fagent
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signup", async () => {
    // Navigate: /signup#/?redirect=%2Fagent
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signup", async () => {
    // Navigate: /signup#/?redirect=%2Fagent
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signup → /", async () => {
    // Navigate: /signup#/?redirect=%2Fagent
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signup → /pricing", async () => {
    // Navigate: /signup#/?redirect=%2Fagent
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signup → /contact", async () => {
    // Navigate: /signup#/?redirect=%2Fagent
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signup → /signin", async () => {
    // Navigate: /signup#/?redirect=%2Fagent
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Page loads: /signup", async () => {
    // Navigate: /signup#/?redirect=%2Fintegrations
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signup", async () => {
    // Navigate: /signup#/?redirect=%2Fintegrations
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signup", async () => {
    // Navigate: /signup#/?redirect=%2Fintegrations
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signup → /", async () => {
    // Navigate: /signup#/?redirect=%2Fintegrations
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signup → /pricing", async () => {
    // Navigate: /signup#/?redirect=%2Fintegrations
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signup → /contact", async () => {
    // Navigate: /signup#/?redirect=%2Fintegrations
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signup → /signin", async () => {
    // Navigate: /signup#/?redirect=%2Fintegrations
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Page loads: /signup", async () => {
    // Navigate: /signup#/?redirect=%2Fsuite%2Fplaywright-ts
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signup", async () => {
    // Navigate: /signup#/?redirect=%2Fsuite%2Fplaywright-ts
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signup", async () => {
    // Navigate: /signup#/?redirect=%2Fsuite%2Fplaywright-ts
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signup → /", async () => {
    // Navigate: /signup#/?redirect=%2Fsuite%2Fplaywright-ts
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signup → /pricing", async () => {
    // Navigate: /signup#/?redirect=%2Fsuite%2Fplaywright-ts
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signup → /contact", async () => {
    // Navigate: /signup#/?redirect=%2Fsuite%2Fplaywright-ts
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signup → /signin", async () => {
    // Navigate: /signup#/?redirect=%2Fsuite%2Fplaywright-ts
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Page loads: /signup", async () => {
    // Navigate: /signup#/?plan=free
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signup", async () => {
    // Navigate: /signup#/?plan=free
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signup", async () => {
    // Navigate: /signup#/?plan=free
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signup → /", async () => {
    // Navigate: /signup#/?plan=free
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signup → /pricing", async () => {
    // Navigate: /signup#/?plan=free
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signup → /contact", async () => {
    // Navigate: /signup#/?plan=free
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signup → /signin", async () => {
    // Navigate: /signup#/?plan=free
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Page loads: /signup", async () => {
    // Navigate: /signup#/?plan=pro
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signup", async () => {
    // Navigate: /signup#/?plan=pro
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signup", async () => {
    // Navigate: /signup#/?plan=pro
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signup → /", async () => {
    // Navigate: /signup#/?plan=pro
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signup → /pricing", async () => {
    // Navigate: /signup#/?plan=pro
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signup → /contact", async () => {
    // Navigate: /signup#/?plan=pro
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signup → /signin", async () => {
    // Navigate: /signup#/?plan=pro
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });

it("Page loads: /signup", async () => {
    // Navigate: /signup#/?plan=team
    await driver.$(`xpath=//*[contains(., "testmind-web")]`).waitForDisplayed();
  });

it("Form submits – /signup", async () => {
    // Navigate: /signup#/?plan=team
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("[name='firstName'], #firstName").setValue("QA Auto");
    await driver.$("[name='lastName'], #lastName").setValue("QA Auto");
    await driver.$("[name='emailAddress'], #emailAddress").setValue("qa+auto@example.com");
    await driver.$("[name='password'], #password").setValue("P@ssw0rd1!");
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "success")]`).waitForDisplayed();
  });

it("Validation blocks empty submission – /signup", async () => {
    // Navigate: /signup#/?plan=team
    await driver.$("button[type='submit'], input[type='submit']").click();
    await driver.$(`xpath=//*[contains(., "required")]`).waitForDisplayed();
  });

it("Navigate /signup → /", async () => {
    // Navigate: /signup#/?plan=team
    // Navigate: /
    await driver.$(`xpath=//*[contains(., "Page")]`).waitForDisplayed();
  });

it("Navigate /signup → /pricing", async () => {
    // Navigate: /signup#/?plan=team
    // Navigate: /pricing
    await driver.$(`xpath=//*[contains(., "pricing")]`).waitForDisplayed();
  });

it("Navigate /signup → /contact", async () => {
    // Navigate: /signup#/?plan=team
    // Navigate: /contact
    await driver.$(`xpath=//*[contains(., "contact")]`).waitForDisplayed();
  });

it("Navigate /signup → /signin", async () => {
    // Navigate: /signup#/?plan=team
    // Navigate: /signin
    await driver.$(`xpath=//*[contains(., "signin")]`).waitForDisplayed();
  });
});
