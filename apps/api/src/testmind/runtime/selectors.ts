export function toButtonLocator(name?: string) {
  return name ? `getByRole('button', { name: ${JSON.stringify(name)} })` : `locator('button').first()`;
}
export function toLinkLocator(name?: string) {
  return name ? `getByRole('link', { name: ${JSON.stringify(name)} })` : `locator('a').first()`;
}
export function toFieldLocator(f: {name?:string; label?:string; placeholder?:string; type?:string}) {
  if (f.label)        return `getByLabel(${JSON.stringify(f.label)})`;
  if (f.placeholder)  return `getByPlaceholder(${JSON.stringify(f.placeholder)})`;
  if (f.name)         return `locator('[name=${JSON.stringify(f.name)}]')`;
  if (f.type)         return `locator('input[type=${JSON.stringify(f.type)}]')`;
  return `locator('input, textarea, select').first()`;
}

export function fakeValue(f: {name?:string; type?:string; placeholder?:string}) {
  const n = (f.name ?? f.placeholder ?? "").toLowerCase();
  if (f.type === "email" || n.includes("email")) return "qa+auto@example.com";
  if (f.type === "tel"   || n.includes("phone")) return "4045551234";
  if (n.includes("zip")) return "30301";
  if (n.includes("name")) return "QA Auto";
  if (f.type === "password") return "P@ssw0rd!";
  return "Test value";
}
