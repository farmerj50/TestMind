// Enhanced scanner.ts – discovers inputs, dropdowns, buttons, and more

import { load } from "cheerio";
import { URL } from "url";

export type Field = {
  name: string;
  type: string;
  required?: boolean;
  placeholder?: string;
  label?: string;
};

export type RouteScan = {
  url: string;
  title?: string;
  links: string[];
  fields: Field[];
  buttons: string[];
  selects: string[];
  fileInputs: string[];
  checkboxes: string[];
  radios: string[];
  hasForm: boolean;
};

function sameOrigin(base: string, href: string) {
  try {
    const u = new URL(href, base);
    const b = new URL(base);
    return u.origin === b.origin ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function scanRoute(url: string): Promise<RouteScan> {
  const res = await fetch(url);
  const html = await res.text();
  const $ = load(html);

  const title = $("title").first().text().trim();

  const fields: Field[] = [];
  $("input, textarea, select").each((_, el) => {
    const $el = $(el);
    const tag = el.tagName.toLowerCase();
    const name = $el.attr("name") || $el.attr("id") || "";
    if (!name) return;

    const label = $(`label[for='${name}']`).text().trim();
    const field: Field = {
      name,
      type: $el.attr("type") || tag,
      required: $el.is("[required]"),
      placeholder: $el.attr("placeholder"),
      label,
    };
    fields.push(field);
  });

  const buttons: string[] = [];
  $("button, input[type='submit']").each((_, el) => {
    const text = $(el).text().trim() || $(el).attr("value") || "Submit";
    buttons.push(text);
  });

  const selects: string[] = [];
  $("select").each((_, el) => {
    const name = $(el).attr("name") || $(el).attr("id") || "";
    if (name) selects.push(name);
  });

  const fileInputs: string[] = [];
  $("input[type='file']").each((_, el) => {
    const name = $(el).attr("name") || $(el).attr("id") || "";
    if (name) fileInputs.push(name);
  });

  const checkboxes: string[] = [];
  $("input[type='checkbox']").each((_, el) => {
    const name = $(el).attr("name") || $(el).attr("id") || "";
    if (name) checkboxes.push(name);
  });

  const radios: string[] = [];
  $("input[type='radio']").each((_, el) => {
    const name = $(el).attr("name") || $(el).attr("id") || "";
    if (name) radios.push(name);
  });

  const links: string[] = [];
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href")!;
    const full = sameOrigin(url, href);
    if (full) links.push(full.split("#")[0]);
  });

  return {
    url,
    title,
    links: Array.from(new Set(links)),
    fields,
    buttons,
    selects,
    fileInputs,
    checkboxes,
    radios,
    hasForm: fields.length > 0,
  };
}
