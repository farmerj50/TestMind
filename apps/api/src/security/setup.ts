import { z } from "zod";
import type {
  ApiSecurityFixture,
  ExpectedSecurityControl,
  SecurityAuthProfile,
  SecurityTestSetup,
} from "./types.js";

export const SECURITY_TEST_SETUP_PROVIDER = "security_test_setup";

export const expectedSecurityControlSchema = z.enum([
  "auth_required",
  "object_owner_required",
  "role_admin_required",
  "no_sensitive_fields",
  "strict_cors",
  "secure_cookies",
  "no_error_disclosure",
  "input_validation",
]);

export const securityAuthProfileSchema = z.object({
  label: z.string().trim().min(1).max(80),
  role: z.string().trim().max(80).optional(),
  type: z.enum(["none", "bearer", "cookie", "basic"]).default("none"),
  token: z.string().optional(),
  tokenSecretKey: z.string().optional(),
  cookieName: z.string().optional(),
  cookieValue: z.string().optional(),
  cookieValueSecretKey: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  passwordSecretKey: z.string().optional(),
});

export const apiSecurityFixtureSchema = z.object({
  name: z.string().optional(),
  route: z.string().min(1),
  method: z.string().default("GET"),
  ownerProfile: z.string().optional(),
  otherProfile: z.string().optional(),
  adminProfile: z.string().optional(),
  lowPrivilegeProfile: z.string().optional(),
  ownerObjectId: z.string().optional(),
  otherObjectId: z.string().optional(),
  expectedDenyStatuses: z.array(z.number().int()).optional(),
  expectedControls: z.array(expectedSecurityControlSchema).optional(),
  forbiddenFields: z.array(z.string()).optional(),
});

const securityTestSetupBaseSchema = z.object({
  authProfiles: z.array(securityAuthProfileSchema).default([]),
  apiFixtures: z.array(apiSecurityFixtureSchema).default([]),
  expectedControls: z.array(expectedSecurityControlSchema).default([]),
  owaspCategories: z.array(z.string()).default([]),
  complianceFrameworks: z.array(z.string()).default([]),
});

export const securityTestSetupSchema = securityTestSetupBaseSchema.superRefine((setup, ctx) => {
  setup.authProfiles.forEach((profile, index) => {
    if (profile.token || profile.cookieValue || profile.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authProfiles", index],
        message:
          "Saved auth profiles must reference ProjectSecret keys instead of storing raw tokens, cookies, or passwords.",
      });
    }
    if (profile.type === "bearer" && !profile.tokenSecretKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authProfiles", index, "tokenSecretKey"],
        message: "Bearer profiles need tokenSecretKey.",
      });
    }
    if (profile.type === "cookie" && (!profile.cookieName || !profile.cookieValueSecretKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authProfiles", index, "cookieValueSecretKey"],
        message: "Cookie profiles need cookieName and cookieValueSecretKey.",
      });
    }
    if (profile.type === "basic" && (!profile.username || !profile.passwordSecretKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authProfiles", index, "passwordSecretKey"],
        message: "Basic profiles need username and passwordSecretKey.",
      });
    }
  });
});

export function emptySecurityTestSetup(): SecurityTestSetup {
  return {
    authProfiles: [],
    apiFixtures: [],
    expectedControls: [],
    owaspCategories: [],
    complianceFrameworks: [],
  };
}

export function parseSecurityTestSetup(value: unknown): SecurityTestSetup {
  const parsed = securityTestSetupBaseSchema.safeParse(value ?? {});
  if (!parsed.success) return emptySecurityTestSetup();
  return parsed.data as SecurityTestSetup;
}

function profileKey(profile: SecurityAuthProfile) {
  return profile.label.trim().toLowerCase();
}

function fixtureKey(fixture: ApiSecurityFixture) {
  return `${(fixture.method ?? "GET").toUpperCase()} ${fixture.route.trim()}`;
}

export function mergeSecurityTestSetup(
  saved: SecurityTestSetup,
  overrides: Partial<SecurityTestSetup>
): SecurityTestSetup {
  const profiles = new Map<string, SecurityAuthProfile>();
  for (const profile of saved.authProfiles) profiles.set(profileKey(profile), profile);
  for (const profile of overrides.authProfiles ?? []) profiles.set(profileKey(profile), profile);

  const fixtures = new Map<string, ApiSecurityFixture>();
  for (const fixture of saved.apiFixtures) fixtures.set(fixtureKey(fixture), fixture);
  for (const fixture of overrides.apiFixtures ?? []) fixtures.set(fixtureKey(fixture), fixture);

  const expectedControls = new Set<ExpectedSecurityControl>([
    ...saved.expectedControls,
    ...(overrides.expectedControls ?? []),
  ]);
  const owaspCategories = new Set([...saved.owaspCategories, ...(overrides.owaspCategories ?? [])]);
  const complianceFrameworks = new Set([
    ...saved.complianceFrameworks,
    ...(overrides.complianceFrameworks ?? []),
  ]);

  return {
    authProfiles: [...profiles.values()],
    apiFixtures: [...fixtures.values()],
    expectedControls: [...expectedControls],
    owaspCategories: [...owaspCategories],
    complianceFrameworks: [...complianceFrameworks],
  };
}
