import { expect, test } from "@playwright/test";
import { RuleTester } from "eslint";
import fieldPartsInRoot from "../../../eslint-rules/field-parts-in-root.mjs";

// Base UI throws at render when a Field label, description, or error has no
// Field root above it. The lint rule catches that at edit time; these cases
// own what it accepts and refuses.
RuleTester.describe = (name: string, body: () => void) =>
  test.describe(name, body);
RuleTester.it = (name: string, body: () => void) =>
  test(name, () => {
    expect(body).not.toThrow();
  });

const importField =
  'import { Field as FormField, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";\n';

new RuleTester({
  languageOptions: {
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
}).run("field-parts-in-root", fieldPartsInRoot, {
  valid: [
    // A label and an error inside an aliased Field root.
    `${importField}export const A = () => <FormField><FieldLabel htmlFor="n">Name</FieldLabel><input id="n" /><FieldError>Bad</FieldError></FormField>;`,
    // A part rendered by a map callback that sits inside the root.
    `${importField}export const B = ({ items }) => <FormField>{items.map((item) => <FieldLabel key={item}>{item}</FieldLabel>)}</FormField>;`,
    // A same-named component from another module is not a Field part.
    'import { FieldLabel } from "./other";\nexport const C = () => <div><FieldLabel>Name</FieldLabel></div>;',
  ],
  invalid: [
    // The User-field note that crashed the Sandbox designer.
    {
      code: `${importField}export const D = () => <div><p>Default value</p><FieldDescription>No shared default.</FieldDescription></div>;`,
      errors: [
        { messageId: "outsideRoot", data: { name: "FieldDescription" } },
      ],
    },
    // A root in another component does not count.
    {
      code: `${importField}const Label = () => <FieldLabel>Name</FieldLabel>;\nexport const E = () => <FormField><Label /></FormField>;`,
      errors: [{ messageId: "outsideRoot", data: { name: "FieldLabel" } }],
    },
  ],
});
