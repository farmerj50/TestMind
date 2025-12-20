from pathlib import Path
text = Path('apps/web/testmind-generated/playwright-ts-user_36fE7NhJd4BiVLk3EXpdpVh7J4m/case-type-selection.spec.ts').read_text()
idx = text.index('Ensure text')
print(text[idx:idx+120])
