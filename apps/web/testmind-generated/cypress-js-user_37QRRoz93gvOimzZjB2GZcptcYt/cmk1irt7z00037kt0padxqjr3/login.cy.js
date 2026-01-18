// Auto-generated for /login - 6 test(s)
const BASE_URL = Cypress.env("BASE_URL") || "/login";

describe("/login", () => {
it("Page loads: /login", () => {
    cy.visit("https://www.justicepathlaw.com/login")
    cy.contains("JusticePath — Accessible Legal Help").should("be.visible")
  });

it("Form submits – /login", () => {
    cy.visit("https://www.justicepathlaw.com/login")
    cy.get("[name='Email Address'], #Email Address").clear().type("qa+auto@example.com")
    cy.get("[name='Password'], #Password").clear().type("P@ssw0rd1!")
    cy.get("button[type='submit'], input[type='submit']").click()
    cy.contains("success").should("be.visible")
  });

it("Navigate /login → /", () => {
    cy.visit("https://www.justicepathlaw.com/login")
    cy.visit("/")
    cy.contains("Page").should("be.visible")
  });

it("Navigate /login → /live-chat", () => {
    cy.visit("https://www.justicepathlaw.com/login")
    cy.visit("/live-chat")
    cy.contains("live-chat").should("be.visible")
  });

it("Navigate /login → /pricing", () => {
    cy.visit("https://www.justicepathlaw.com/login")
    cy.visit("/pricing")
    cy.contains("pricing").should("be.visible")
  });

it("Navigate /login → /signup", () => {
    cy.visit("https://www.justicepathlaw.com/login")
    cy.visit("/signup")
    cy.contains("signup").should("be.visible")
  });
});
