import {
  createElement,
  Fragment,
  type FunctionComponent,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Playwright compiles the JSX of every `.tsx` file it loads with its own
// component-test runtime (`playwright/jsx-runtime`), which returns plain
// `{ __pw_type: "jsx", type, props, key }` objects instead of React elements.
// This adapter turns that tree back into React elements while React renders,
// so an isolated test can render a real component without changing it.

type PlaywrightElement = {
  __pw_type: "jsx";
  type: unknown;
  props: Record<string, unknown> | null;
  key?: string | number | null;
};

function isPlaywrightElement(value: unknown): value is PlaywrightElement {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __pw_type?: unknown }).__pw_type === "jsx"
  );
}

const adapters = new WeakMap<object, FunctionComponent>();

function reactType(type: unknown): unknown {
  if (typeof type === "object" && type !== null && "__pw_jsx_fragment" in type)
    return Fragment;
  if (typeof type !== "function") return type;
  const known = adapters.get(type);
  if (known) return known;
  const component = type as (props: unknown) => unknown;
  const adapter: FunctionComponent = (props) =>
    toReact(component(props)) as ReactElement | null;
  adapter.displayName = component.name;
  adapters.set(type, adapter);
  return adapter;
}

function toReact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toReact);
  if (!isPlaywrightElement(value)) return value;
  const { children, ...props } = value.props ?? {};
  const converted = Object.fromEntries(
    Object.entries(props).map(([name, prop]) => [name, toReact(prop)]),
  );
  if (value.key !== undefined && value.key !== null) converted.key = value.key;
  const type = reactType(value.type) as Parameters<typeof createElement>[0];
  // Static children (`jsxs`) are spread so React does not ask for list keys.
  return Array.isArray(children)
    ? createElement(type, converted, ...(children.map(toReact) as ReactNode[]))
    : children === undefined
      ? createElement(type, converted)
      : createElement(type, converted, toReact(children) as ReactNode);
}

/** Server-renders a `.tsx` component and drops React's text separators. */
export function staticMarkup<Props extends object>(
  component: (props: Props) => unknown,
  props: Props,
): string {
  const type = reactType(component) as FunctionComponent<Props>;
  return renderToStaticMarkup(createElement(type, props)).replaceAll(
    "<!-- -->",
    "",
  );
}
