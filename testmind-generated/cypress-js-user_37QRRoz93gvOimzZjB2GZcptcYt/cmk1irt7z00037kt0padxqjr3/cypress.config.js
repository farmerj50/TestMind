const { defineConfig } = require("cypress");

module.exports = defineConfig({
  e2e: {
    baseUrl: process.env.BASE_URL || "http://localhost:4173",
    specPattern: "testmind-generated/cypress-js/**/*.cy.js",
    supportFile: false,
    video: false,
  },
});