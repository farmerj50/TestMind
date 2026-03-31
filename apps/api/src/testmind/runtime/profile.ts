// A compact profile we can extend later.
export type UserProfile = {
  basic: {
    firstName: string; lastName: string; email: string; phone: string;
  };
  address?: { line1: string; line2?: string; city: string; state: string; zip: string; country?: string };
  work?: Array<{ company: string; title: string; start?: string; end?: string; summary?: string }>;
  education?: Array<{ school: string; degree?: string; start?: string; end?: string }>;
  skills?: string[];
  files?: { resumePdf?: string; resumeDocx?: string; coverLetter?: string; portfolioZip?: string };
  extras?: Record<string, string>;        // any arbitrary key → value
};

// Basic profile for testing. Replace with real data or load from disk/env.
export const demoProfile: UserProfile = {
  basic: {
    firstName: "Case", lastName: "Tester",
    email: `user${Date.now()}@example.com`,
    phone: "5551234567",
  },
  address: { line1: "1 Infinite Loop", city: "Cupertino", state: "CA", zip: "95014", country: "US" },
  skills: ["TypeScript", "Playwright", "Node.js"],
  files: { resumePdf: "tests/assets/resume.pdf" },
  extras: {
    // Common answers you might see
    "citizenship": "US",
    "work authorization": "Authorized",
    "relocation": "No",
    "salary": "120000",
    "notice period": "2 weeks",
  }
};
