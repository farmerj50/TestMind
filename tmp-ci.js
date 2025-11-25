const server = 'C:/tmp/app';
const win = server.replace(/\\/g,'\\\\').replace(/'/g,"''");
const unix = server.replace(/\\/g,'/').replace(/"/g,'\\"');
const PORT_PLACEHOLDER = '__TM_PORT__';
const winDevCommand = `powershell -NoProfile -Command "& {Set-Location -Path '${win}'; pnpm install; pnpm dev --host localhost --port ${PORT_PLACEHOLDER} --strictPort }"`;
const unixDevCommand = `bash -lc "cd \"${unix}\" && pnpm install && pnpm dev --host 0.0.0.0 --port ${PORT_PLACEHOLDER} --strictPort"`;
const ci = `const DEV_COMMAND = process.platform === 'win32'
  ? \`${winDevCommand}\`
  : \`${unixDevCommand}\`;
`;
console.log(ci.replace(/__TM_PORT__/g, '${PORT}'));
