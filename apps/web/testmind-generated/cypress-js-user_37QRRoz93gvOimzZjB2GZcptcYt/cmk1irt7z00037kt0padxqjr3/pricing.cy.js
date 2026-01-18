// Auto-generated for /pricing - 5 test(s)
const BASE_URL = Cypress.env("BASE_URL") || "/pricing";

describe("/pricing", () => {
it("Page loads: /pricing", () => {
    cy.visit("https://www.justicepathlaw.com/pricing")
    cy.contains("JusticePath — Accessible Legal Help").should("be.visible")
  });

it("Navigate /pricing → /", () => {
    cy.visit("https://www.justicepathlaw.com/pricing")
    cy.visit("/")
    cy.contains("Page").should("be.visible")
  });

it("Navigate /pricing → /live-chat", () => {
    cy.visit("https://www.justicepathlaw.com/pricing")
    cy.visit("/live-chat")
    cy.contains("live-chat").should("be.visible")
  });

it("Navigate /pricing → /login", () => {
    cy.visit("https://www.justicepathlaw.com/pricing")
    cy.visit("/login")
    cy.contains("login").should("be.visible")
  });

it("Navigate /pricing → /signup", () => {
    cy.visit("https://www.justicepathlaw.com/pricing")
    cy.visit("/signup")
    cy.contains("signup").should("be.visible")
  });
});
