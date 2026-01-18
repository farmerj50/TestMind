// Auto-generated for /signup - 6 test(s)
const BASE_URL = Cypress.env("BASE_URL") || "/signup";

describe("/signup", () => {
it("Page loads: /signup", () => {
    cy.visit("https://www.justicepathlaw.com/signup")
    cy.contains("JusticePath — Accessible Legal Help").should("be.visible")
  });

it("Form submits – /signup", () => {
    cy.visit("https://www.justicepathlaw.com/signup")
    cy.get("[name='Full Name'], #Full Name").clear().type("QA Auto")
    cy.get("[name='Email Address'], #Email Address").clear().type("qa+auto@example.com")
    cy.get("[name='Password'], #Password").clear().type("P@ssw0rd1!")
    cy.get("[name='Confirm Password'], #Confirm Password").clear().type("P@ssw0rd1!")
    cy.get("button[type='submit'], input[type='submit']").click()
    cy.contains("success").should("be.visible")
  });

it("Navigate /signup → /", () => {
    cy.visit("https://www.justicepathlaw.com/signup")
    cy.visit("/")
    cy.contains("Page").should("be.visible")
  });

it("Navigate /signup → /live-chat", () => {
    cy.visit("https://www.justicepathlaw.com/signup")
    cy.visit("/live-chat")
    cy.contains("live-chat").should("be.visible")
  });

it("Navigate /signup → /pricing", () => {
    cy.visit("https://www.justicepathlaw.com/signup")
    cy.visit("/pricing")
    cy.contains("pricing").should("be.visible")
  });

it("Navigate /signup → /login", () => {
    cy.visit("https://www.justicepathlaw.com/signup")
    cy.visit("/login")
    cy.contains("login").should("be.visible")
  });
});
