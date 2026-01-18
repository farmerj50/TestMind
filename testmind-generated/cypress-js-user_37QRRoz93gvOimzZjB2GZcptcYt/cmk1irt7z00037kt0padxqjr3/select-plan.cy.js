// Auto-generated for /select-plan - 6 test(s)
const BASE_URL = Cypress.env("BASE_URL") || "/select-plan";

describe("/select-plan", () => {
it("Page loads: /select-plan", () => {
    cy.visit("https://www.justicepathlaw.com/select-plan")
    cy.contains("JusticePath — Accessible Legal Help").should("be.visible")
  });

it("Navigate /select-plan → /", () => {
    cy.visit("https://www.justicepathlaw.com/select-plan")
    cy.visit("/")
    cy.contains("Page").should("be.visible")
  });

it("Navigate /select-plan → /live-chat", () => {
    cy.visit("https://www.justicepathlaw.com/select-plan")
    cy.visit("/live-chat")
    cy.contains("live-chat").should("be.visible")
  });

it("Navigate /select-plan → /pricing", () => {
    cy.visit("https://www.justicepathlaw.com/select-plan")
    cy.visit("/pricing")
    cy.contains("pricing").should("be.visible")
  });

it("Navigate /select-plan → /login", () => {
    cy.visit("https://www.justicepathlaw.com/select-plan")
    cy.visit("/login")
    cy.contains("login").should("be.visible")
  });

it("Navigate /select-plan → /signup", () => {
    cy.visit("https://www.justicepathlaw.com/select-plan")
    cy.visit("/signup")
    cy.contains("signup").should("be.visible")
  });
});
