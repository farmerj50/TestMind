// Auto-generated for /live-chat - 6 test(s)
const BASE_URL = Cypress.env("BASE_URL") || "/live-chat";

describe("/live-chat", () => {
it("Page loads: /live-chat", () => {
    cy.visit("https://www.justicepathlaw.com/live-chat")
    cy.contains("JusticePath — Accessible Legal Help").should("be.visible")
  });

it("Form submits – /live-chat", () => {
    cy.visit("https://www.justicepathlaw.com/live-chat")
    cy.get("[name='Jurisdiction (e.g., Atlanta, GA)'], #Jurisdiction (e.g., Atlanta, GA)").clear().type("Test value")
    cy.get("button[type='submit'], input[type='submit']").click()
    cy.contains("success").should("be.visible")
  });

it("Navigate /live-chat → /", () => {
    cy.visit("https://www.justicepathlaw.com/live-chat")
    cy.visit("/")
    cy.contains("Page").should("be.visible")
  });

it("Navigate /live-chat → /pricing", () => {
    cy.visit("https://www.justicepathlaw.com/live-chat")
    cy.visit("/pricing")
    cy.contains("pricing").should("be.visible")
  });

it("Navigate /live-chat → /login", () => {
    cy.visit("https://www.justicepathlaw.com/live-chat")
    cy.visit("/login")
    cy.contains("login").should("be.visible")
  });

it("Navigate /live-chat → /signup", () => {
    cy.visit("https://www.justicepathlaw.com/live-chat")
    cy.visit("/signup")
    cy.contains("signup").should("be.visible")
  });
});
