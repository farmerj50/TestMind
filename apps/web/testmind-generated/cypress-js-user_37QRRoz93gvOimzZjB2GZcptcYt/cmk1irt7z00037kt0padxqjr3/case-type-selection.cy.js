// Auto-generated for /case-type-selection - 6 test(s)
const BASE_URL = Cypress.env("BASE_URL") || "/case-type-selection";

describe("/case-type-selection", () => {
it("Page loads: /case-type-selection", () => {
    cy.visit("https://www.justicepathlaw.com/case-type-selection")
    cy.contains("JusticePath — Accessible Legal Help").should("be.visible")
  });

it("Navigate /case-type-selection → /", () => {
    cy.visit("https://www.justicepathlaw.com/case-type-selection")
    cy.visit("/")
    cy.contains("Page").should("be.visible")
  });

it("Navigate /case-type-selection → /live-chat", () => {
    cy.visit("https://www.justicepathlaw.com/case-type-selection")
    cy.visit("/live-chat")
    cy.contains("live-chat").should("be.visible")
  });

it("Navigate /case-type-selection → /pricing", () => {
    cy.visit("https://www.justicepathlaw.com/case-type-selection")
    cy.visit("/pricing")
    cy.contains("pricing").should("be.visible")
  });

it("Navigate /case-type-selection → /login", () => {
    cy.visit("https://www.justicepathlaw.com/case-type-selection")
    cy.visit("/login")
    cy.contains("login").should("be.visible")
  });

it("Navigate /case-type-selection → /signup", () => {
    cy.visit("https://www.justicepathlaw.com/case-type-selection")
    cy.visit("/signup")
    cy.contains("signup").should("be.visible")
  });
});
