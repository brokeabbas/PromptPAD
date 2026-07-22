import { describe, expect, it } from "vitest";
import {
  buildPromptOutput,
  getImportSpecifiers,
  normalizeRelativePath,
} from "./App";

describe("prompt assembly", () => {
  it("normalizes Windows paths", () => {
    expect(normalizeRelativePath(".\\src\\main.ts")).toBe("src/main.ts");
  });

  it("extracts unique static and dynamic imports", () => {
    const imports = getImportSpecifiers(`
      import value from "./value?raw";
      export { helper } from "@/helper";
      const lazy = import("./lazy");
      const again = require("./value?raw");
    `);

    expect(imports).toEqual(["./value", "@/helper", "./lazy"]);
  });

  it("places the personal prompt before selected files", () => {
    const output = buildPromptOutput(" Review this. ", [
      {
        path: "C:\\project\\src\\main.ts",
        relativePath: "src\\main.ts",
        name: "main.ts",
        extension: "ts",
        size: 18,
        content: "export const ok = 1;\n",
        charCount: 19,
        addedAt: 1,
      },
    ]);

    expect(output).toBe(
      "personal-prompt.md\nReview this.\n\nsrc/main.ts\nexport const ok = 1;"
    );
  });
});
