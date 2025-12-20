# -*- coding: utf-8 -*-
from pathlib import Path
path = Path('apps/web/testmind-generated/playwright-ts-user_36fE7NhJd4BiVLk3EXpdpVh7J4m/case-type-selection.spec.ts')
text = path.read_text()
marker = '  await test.step("2. Ensure text'
start = text.index(marker)
end = text.index('  });\n', start) + len('  });\n')
old = text[start:end]
new = ('  await test.step("2. Ensure heading \"Accessible Legal Help for Everyone\" is visible", async () => {\n'
       '    await expect(\n'
       '      page.getByRole("heading", { name: "Accessible Legal Help for Everyone" })\n'
       '    ).toBeVisible({ timeout: 10000 });\n'
       '  });\n')
text = text.replace(old, new, 1)
path.write_text(text)
