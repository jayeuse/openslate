import type { Rule } from "eslint";

// Base UI's Field label, description, and error read the Field root's context
// and throw at render without it. This rule reports those parts from
// `@/components/ui/field` when no Field root encloses them in the same JSX.
const SOURCE = "@/components/ui/field";
const ROOT = "Field";
const PARTS = new Set(["FieldLabel", "FieldDescription", "FieldError"]);

type JsxTreeNode = {
  type: string;
  parent?: JsxTreeNode;
  openingElement?: { name: { type: string; name?: string } };
};

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require Field labels, descriptions, and errors inside a Field root",
    },
    messages: {
      outsideRoot:
        "Put {{name}} inside a <Field> root in the same JSX: Base UI throws at render without one. Use plain text for a note that has no control.",
    },
    schema: [],
  },
  create(context) {
    const parts = new Map<string, string>();
    let rootName: string | null = null;

    function insideRoot(node: JsxTreeNode): boolean {
      for (let current = node.parent; current; current = current.parent) {
        const name = current.openingElement?.name;
        if (
          current.type === "JSXElement" &&
          name?.type === "JSXIdentifier" &&
          name.name === rootName
        )
          return true;
      }
      return false;
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value !== SOURCE) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const imported =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : String(specifier.imported.value);
          if (imported === ROOT) rootName = specifier.local.name;
          else if (PARTS.has(imported))
            parts.set(specifier.local.name, imported);
        }
      },
      JSXElement(node: Rule.Node) {
        const element = node as unknown as JsxTreeNode;
        const name = element.openingElement?.name;
        if (name?.type !== "JSXIdentifier" || name.name === undefined) return;
        const part = parts.get(name.name);
        if (part === undefined || insideRoot(element)) return;
        context.report({
          node,
          messageId: "outsideRoot",
          data: { name: part },
        });
      },
    };
  },
};

export default rule;
