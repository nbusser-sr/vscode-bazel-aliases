import typescriptEslint from "typescript-eslint";

export default [{
  files: ["**/*.ts"],
}, {
  plugins: {
    "@typescript-eslint": typescriptEslint.plugin,
  },

  languageOptions: {
    parser: typescriptEslint.parser,
    ecmaVersion: 2022,
    sourceType: "module",
  },

  rules: {
    "@typescript-eslint/naming-convention": ["warn", {
      selector: "import",
      format: ["camelCase", "PascalCase"],
    }],

    eqeqeq: ["warn", "always", { null: "ignore" }],
    quotes: ["warn", "double"],
    "no-throw-literal": "warn",
    semi: "warn",
  },
}];
