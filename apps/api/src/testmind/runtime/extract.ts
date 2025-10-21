import type { Page, ElementHandle } from 'playwright';

type ElHandle = ElementHandle<unknown>;

export type FieldNode = {
  el: ElHandle; // resolved after evaluate
  path: string;
  type:
    | 'text' | 'email' | 'tel' | 'number' | 'password'
    | 'textarea' | 'select' | 'radio' | 'checkbox'
    | 'date' | 'file';
  name?: string;
  id?: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  groupLabel?: string;
  min?: number;
  max?: number;
  pattern?: string;
};

// The serializable shape coming back from page.evaluate (no ElementHandle here)
type RawField = Omit<FieldNode, 'el'>;

export async function extractFields(page: Page): Promise<FieldNode[]> {
  const raw: RawField[] = await page.evaluate(() => {
    const doc = (globalThis as any).document as any;

    // Lightweight CSS.escape polyfill
    const css: any = (globalThis as any).CSS || {};
    if (typeof css.escape !== 'function') {
      css.escape = (s: string) =>
        String(s).replace(/"/g, '\\"').replace(/#/g, '\\#').replace(/\./g, '\\.');
      (globalThis as any).CSS = css;
    }

    const labelFor = (el: any) => {
      const id = el?.id;
      const byFor = id ? doc.querySelector(`label[for="${id}"]`) : null;
      const aria = el?.getAttribute?.('aria-label');
      const ph = el?.placeholder;
      return ((byFor?.textContent ?? aria ?? ph ?? '') + '').trim();
    };

    const groupOf = (el: any) => {
      const fs = el?.closest?.('fieldset') as any;
      const legend = fs?.querySelector?.('legend') as any;
      return ((legend?.textContent ?? '') + '').trim();
    };

    const build = (el: any): RawField => {
      const tag = (el?.tagName || '').toLowerCase();
      const typeRaw = (el?.type || tag || '').toLowerCase();
      const name = el?.name || '';
      const id = el?.id || '';
      const required = !!el?.hasAttribute?.('required');
      const label = labelFor(el);
      const groupLabel = groupOf(el);
      const placeholder = el?.placeholder || undefined;

      let ftype: RawField['type'] = 'text';
      if (tag === 'textarea') ftype = 'textarea';
      else if (tag === 'select') ftype = 'select';
      else if (typeRaw === 'email') ftype = 'email';
      else if (typeRaw === 'tel') ftype = 'tel';
      else if (typeRaw === 'number') ftype = 'number';
      else if (typeRaw === 'password') ftype = 'password';
      else if (typeRaw === 'date') ftype = 'date';
      else if (typeRaw === 'radio') ftype = 'radio';
      else if (typeRaw === 'checkbox') ftype = 'checkbox';
      else if (typeRaw === 'file') ftype = 'file';

      const path =
        name ? `[name="${(css as any).escape(name)}"]`
        : id ? `#${(css as any).escape(id)}`
        : tag || 'input';

      let options: Array<{ value: string; label: string }> | undefined;
      if (tag === 'select') {
        options = Array.from(el?.querySelectorAll?.('option') ?? []).map((o: any) => ({
          value: o?.value ?? '',
          label: ((o?.textContent ?? '') + '').trim(),
        }));
      } else if (typeRaw === 'radio') {
        const group = name
          ? doc.querySelectorAll(`input[type="radio"][name="${(css as any).escape(name)}"]`)
          : el?.closest?.('form')?.querySelectorAll?.('input[type="radio"]');
        options = Array.from(group ?? []).map((r: any) => ({
          value: r?.value ?? '',
          label: labelFor(r),
        }));
      }

      const min = el?.min ? Number(el.min) : undefined;
      const max = el?.max ? Number(el.max) : undefined;
      const pattern = el?.pattern || undefined;

      return {
        path, type: ftype, name: name || (id || undefined), id: id || undefined,
        label, groupLabel, required, placeholder, min, max, pattern, options
      };
    };

    return Array.from(doc.querySelectorAll('input, select, textarea') as any).map(build);
  });

  const out: FieldNode[] = [];
  for (const rf of raw) {
    const handle = await page.locator(rf.path).first().elementHandle();
    if (!handle) continue;
    out.push({ el: handle, ...rf });
  }
  return out;
}
