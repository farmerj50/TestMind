// Auto-generated for / - 7 test(s)
const BASE_URL = Cypress.env("BASE_URL") || "";

describe("/", () => {
it("Page loads: /", () => {
    cy.visit("https://www.justicepathlaw.com/")
    cy.contains("JusticePath — Accessible Legal Help").should("be.visible")
  });

it("Navigate / → /live-chat", () => {
    cy.visit("https://www.justicepathlaw.com/")
    cy.visit("/live-chat")
    cy.contains("live-chat").should("be.visible")
  });

it("Navigate / → /pricing", () => {
    cy.visit("https://www.justicepathlaw.com/")
    cy.visit("/pricing")
    cy.contains("pricing").should("be.visible")
  });

it("Navigate / → /login", () => {
    cy.visit("https://www.justicepathlaw.com/")
    cy.visit("/login")
    cy.contains("login").should("be.visible")
  });

it("Navigate / → /signup", () => {
    cy.visit("https://www.justicepathlaw.com/")
    cy.visit("/signup")
    cy.contains("signup").should("be.visible")
  });

it("Navigate / → /select-plan", () => {
    cy.visit("https://www.justicepathlaw.com/")
    cy.visit("/select-plan")
    cy.contains("select-plan").should("be.visible")
  });

it("Navigate / → /case-type-selection", () => {
    cy.visit("https://www.justicepathlaw.com/")
    cy.visit("/case-type-selection")
    cy.contains("case-type-selection").should("be.visible")
  });
});
