import tseslint from "typescript-eslint";

export const rules = {
  "@typescript-eslint/no-unnecessary-condition": "error",
  "@typescript-eslint/no-unnecessary-type-assertion": "error",
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/require-await": "error",
  "@typescript-eslint/only-throw-error": "error",
  "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: false }],
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/ban-ts-comment": "error",
  "no-empty": "error",
  "no-nested-ternary": "error",
  eqeqeq: "error",
  complexity: ["error", 15],
  "max-depth": ["error", 4],
  "max-params": ["error", 4],
  "max-lines": ["error", { max: 1000 }],
};

export default function slopgateLint({ tsconfigRootDir = process.cwd(), files = ["**/*.{ts,tsx,mts,cts}"], ignores = [] } = {}) {
  return [
    { ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/build/**", ...ignores] },
    {
      files,
      languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir } },
      plugins: { "@typescript-eslint": tseslint.plugin },
      linterOptions: { noInlineConfig: true },
      rules,
    },
  ];
}
