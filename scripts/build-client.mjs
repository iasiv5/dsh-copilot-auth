// 把 src/client.jsx 打包为浏览器侧 __ModuleLoader__ CJS 工厂信封。
// 信封结构与 $PKG/dsh-client-ui-settings-models/lib/client.js 首部（L1-8）对齐：
//   window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports } });
// react / react/jsx-runtime 为 external——由宿主 web roster 的模块图提供。
import { writeFile, mkdir } from "node:fs/promises";
import esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["src/client.jsx"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  // jsx: "automatic"（执行 Agent 注 2026-09-04）：esbuild 默认 classic 会产出
  // React.createElement，而组件未导入默认 React；automatic 产出
  // require("react/jsx-runtime")，与 external 列表匹配。
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  write: false,
  minify: false,
});
const body = result.outputFiles[0].text;
const out = `window.__ModuleLoader__.load({\n`
  + `\tid: "@inventec/dsh-copilot-auth",\n`
  + `\tfactory: (require) => {\n`
  + `\t\tvar module = { exports: {} };\n`
  + `\t\tvar exports = module.exports;\n`
  + `\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n`
  + body + `\n`
  + `\t\treturn module.exports;\n`
  + `\t}\n});\n`;
await mkdir("lib", { recursive: true });
await writeFile("lib/client.js", out, "utf8");
console.log("wrote lib/client.js");
