import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import * as ts from "typescript";

export interface FrontendRoute {
  adapter: string;
  function: string;
  method: string;
  path: string;
}

export interface SourceModule {
  file: string;
  source: string;
}

export interface RouteScan {
  routes: FrontendRoute[];
  diagnostics: string[];
}

type DynamicValue = {
  kind: "dynamic";
  label: string;
  isRouteParameter: boolean;
};

type ObjectValue = {
  kind: "object";
  properties: Map<string, StaticValue>;
  hasUnknownSpread: boolean;
};

type StaticValue =
  string | number | boolean | null | DynamicValue | ObjectValue;

interface FunctionDescriptor {
  file: string;
  sourceFile: ts.SourceFile;
  name: string;
  node: ts.FunctionLikeDeclaration;
  exported: boolean;
}

interface Scope {
  descriptor: FunctionDescriptor;
  parameters: Map<string, StaticValue>;
  bindings: Map<string, ts.Expression | StaticValue>;
}

interface RequestSignature {
  pathArgument: number;
  initArgument: number | null;
  prefix: "api" | "none";
}

const GENERIC_WRAPPERS = new Set([
  "apiFetch",
  "apiFetchWithMetadata",
  "apiRequest",
  "openViewReadFetch",
  "safeBoardJson",
  "postJson",
  "eventJson",
  "safeWidgetJson",
  "safeReportJson",
  "safeScheduleJson",
  "safeNotificationJson",
  "documentRequest",
  "versionRequest",
  "requestFileContent",
]);

const REQUEST_SIGNATURES = new Map<string, RequestSignature>([
  ["apiFetch", { pathArgument: 0, initArgument: 2, prefix: "api" }],
  ["apiFetchWithMetadata", { pathArgument: 0, initArgument: 2, prefix: "api" }],
  ["apiRequest", { pathArgument: 0, initArgument: 1, prefix: "api" }],
  ["openViewReadFetch", { pathArgument: 0, initArgument: 2, prefix: "api" }],
  ["safeBoardJson", { pathArgument: 0, initArgument: 2, prefix: "api" }],
  ["postJson", { pathArgument: 0, initArgument: 2, prefix: "api" }],
  ["eventJson", { pathArgument: 0, initArgument: 2, prefix: "api" }],
  ["safeWidgetJson", { pathArgument: 0, initArgument: 2, prefix: "api" }],
  ["safeReportJson", { pathArgument: 0, initArgument: 2, prefix: "api" }],
  ["safeScheduleJson", { pathArgument: 0, initArgument: 1, prefix: "api" }],
  ["safeNotificationJson", { pathArgument: 0, initArgument: 2, prefix: "api" }],
  ["documentRequest", { pathArgument: 0, initArgument: 1, prefix: "api" }],
  ["versionRequest", { pathArgument: 0, initArgument: 1, prefix: "api" }],
  [
    "requestFileContent",
    { pathArgument: 0, initArgument: null, prefix: "api" },
  ],
  ["sendApiRequest", { pathArgument: 0, initArgument: 1, prefix: "api" }],
  ["fetch", { pathArgument: 0, initArgument: 1, prefix: "none" }],
]);

const FRONTEND_ROOT = process.cwd();
const GENERIC_IMPLEMENTATIONS = new Set([
  ...GENERIC_WRAPPERS,
  "sendApiRequest",
]);

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
  );
}

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (node === undefined) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  return null;
}

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function functionDescriptor(
  file: string,
  sourceFile: ts.SourceFile,
  name: string,
  node: ts.FunctionLikeDeclaration,
  exported: boolean,
): FunctionDescriptor | null {
  return node.body === undefined
    ? null
    : { file, sourceFile, name, node, exported };
}

function collectFunctions(
  file: string,
  sourceFile: ts.SourceFile,
): FunctionDescriptor[] {
  const functions: FunctionDescriptor[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const descriptor = functionDescriptor(
        file,
        sourceFile,
        statement.name.text,
        statement,
        hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
          hasModifier(statement, ts.SyntaxKind.DefaultKeyword),
      );
      if (descriptor) functions.push(descriptor);
    }
    if (!ts.isVariableStatement(statement)) continue;
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
        continue;
      const name = declaration.name.text;
      const initializer = declaration.initializer;
      if (isFunctionLike(initializer)) {
        const descriptor = functionDescriptor(
          file,
          sourceFile,
          name,
          initializer,
          exported,
        );
        if (descriptor) functions.push(descriptor);
      }
      if (!exported || !ts.isObjectLiteralExpression(initializer)) continue;
      for (const member of initializer.properties) {
        if (ts.isMethodDeclaration(member) && member.body) {
          const memberName = propertyName(member.name);
          if (memberName === null) continue;
          const descriptor = functionDescriptor(
            file,
            sourceFile,
            `${name}.${memberName}`,
            member,
            true,
          );
          if (descriptor) functions.push(descriptor);
        }
        if (!ts.isPropertyAssignment(member)) continue;
        if (!isFunctionLike(member.initializer)) continue;
        const memberName = propertyName(member.name);
        if (memberName === null) continue;
        const descriptor = functionDescriptor(
          file,
          sourceFile,
          `${name}.${memberName}`,
          member.initializer,
          true,
        );
        if (descriptor) functions.push(descriptor);
      }
    }
  }
  return functions;
}

function isAdapterSource(file: string): boolean {
  return (
    (file.startsWith("frontend/src/components/systems/") &&
      (file.includes("/adapters/") || file.endsWith("/state/api.ts"))) ||
    file === "frontend/src/lib/auth-api.ts" ||
    file === "frontend/src/lib/mfa-api.ts"
  );
}

function routeParameterName(name: string): boolean {
  return (
    /(?:^|_)(?:raw)?[a-z0-9]*id$/i.test(name) || name.toLowerCase() === "id"
  );
}

function dynamic(label: string, isRouteParameter = false): DynamicValue {
  return { kind: "dynamic", label, isRouteParameter };
}

function isStaticValue(
  value: ts.Expression | StaticValue,
): value is StaticValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string"
  );
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function localFunctions(
  modules: Map<string, ts.SourceFile>,
): Map<string, Map<string, FunctionDescriptor>> {
  const result = new Map<string, Map<string, FunctionDescriptor>>();
  for (const [file, sourceFile] of modules) {
    const functions = collectFunctions(file, sourceFile);
    result.set(file, new Map(functions.map((item) => [item.name, item])));
  }
  return result;
}

function functionBody(descriptor: FunctionDescriptor): ts.Block | null {
  return descriptor.node.body && ts.isBlock(descriptor.node.body)
    ? descriptor.node.body
    : null;
}

function makeScope(
  descriptor: FunctionDescriptor,
  args: StaticValue[] = [],
): Scope {
  const parameters = new Map<string, StaticValue>();
  descriptor.node.parameters.forEach((parameter, index) => {
    if (ts.isIdentifier(parameter.name))
      parameters.set(
        parameter.name.text,
        args[index] ??
          dynamic(parameter.name.text, routeParameterName(parameter.name.text)),
      );
  });
  const bindings = new Map<string, ts.Expression | StaticValue>();
  const body = functionBody(descriptor);
  if (body) {
    const collect = (node: ts.Node): void => {
      if (node !== body && isFunctionLike(node)) return;
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          bindings.set(node.name.text, node.initializer);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const key = propertyName(element.propertyName) ?? element.name.text;
            bindings.set(element.name.text, {
              kind: "dynamic",
              label: `destructure:${key}:${node.initializer.getText(descriptor.sourceFile)}`,
              isRouteParameter: routeParameterName(key),
            });
          }
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(body);
  }
  return { descriptor, parameters, bindings };
}

function valueForIdentifier(
  name: string,
  scope: Scope,
  seen: Set<string>,
): StaticValue[] {
  if (scope.parameters.has(name)) return [scope.parameters.get(name)!];
  const binding = scope.bindings.get(name);
  if (binding === undefined) return [dynamic(name, routeParameterName(name))];
  if (isStaticValue(binding)) return [binding];
  const key = `${scope.descriptor.file}:${scope.descriptor.name}:${name}`;
  if (seen.has(key)) return [dynamic(name, false)];
  const nested = new Set(seen);
  nested.add(key);
  return evalValue(binding as ts.Expression, scope, nested);
}

function conditionValue(
  expression: ts.Expression,
  scope: Scope,
  seen: Set<string>,
): boolean | null {
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const inner = conditionValue(expression.operand, scope, seen);
    return inner === null ? null : !inner;
  }
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    const left = evalValue(expression.left, scope, seen);
    const right = evalValue(expression.right, scope, seen);
    if (left.length !== 1 || right.length !== 1) return null;
    const first = left[0];
    const second = right[0];
    if (typeof first === "object" && first !== null && first.kind === "dynamic")
      return null;
    if (
      typeof second === "object" &&
      second !== null &&
      second.kind === "dynamic"
    )
      return null;
    if (
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsToken
    )
      return first === second;
    if (
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsToken
    )
      return first !== second;
  }
  const values = evalValue(expression, scope, seen);
  return values.length === 1 && typeof values[0] === "boolean"
    ? values[0]
    : null;
}

function functionReturns(
  descriptor: FunctionDescriptor,
  args: StaticValue[],
  functions: Map<string, FunctionDescriptor>,
  mode: "value" | "path",
  diagnostics: string[],
  recursion: Set<string>,
): StaticValue[] {
  const key = `${descriptor.file}:${descriptor.name}:${mode}`;
  if (recursion.has(key)) return [dynamic(`recursive:${descriptor.name}`)];
  const nextRecursion = new Set(recursion);
  nextRecursion.add(key);
  const scope = makeScope(descriptor, args);
  const body = functionBody(descriptor);
  if (!body) return [];
  const returns: StaticValue[] = [];
  const collect = (node: ts.Node): void => {
    if (node !== body && isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      returns.push(
        ...(mode === "path"
          ? evalPath(
              node.expression,
              scope,
              functions,
              diagnostics,
              nextRecursion,
            )
          : evalValue(
              node.expression,
              scope,
              nextRecursion,
              functions,
              diagnostics,
            )),
      );
      return;
    }
    if (ts.isIfStatement(node)) {
      const decision = conditionValue(node.expression, scope, nextRecursion);
      if (decision !== false) collect(node.thenStatement);
      if (decision !== true && node.elseStatement) collect(node.elseStatement);
      return;
    }
    ts.forEachChild(node, collect);
  };
  collect(body);
  return returns;
}

function evalValue(
  expression: ts.Expression,
  scope: Scope,
  seen = new Set<string>(),
  functions = new Map<string, FunctionDescriptor>(),
  diagnostics: string[] = [],
): StaticValue[] {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    return evalValue(
      expression.expression,
      scope,
      seen,
      functions,
      diagnostics,
    );
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  )
    return [expression.text];
  if (ts.isNumericLiteral(expression)) return [Number(expression.text)];
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return [true];
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return [false];
  if (expression.kind === ts.SyntaxKind.NullKeyword) return [null];
  if (ts.isIdentifier(expression))
    return valueForIdentifier(expression.text, scope, seen);
  if (ts.isPropertyAccessExpression(expression)) {
    const objectValues = evalValue(
      expression.expression,
      scope,
      seen,
      functions,
      diagnostics,
    );
    const values = objectValues.flatMap((value) => {
      if (
        typeof value === "object" &&
        value !== null &&
        value.kind === "object"
      )
        return value.properties.has(expression.name.text)
          ? [value.properties.get(expression.name.text)!]
          : [
              dynamic(
                expression.name.text,
                routeParameterName(expression.name.text),
              ),
            ];
      return [
        dynamic(expression.name.text, routeParameterName(expression.name.text)),
      ];
    });
    return values;
  }
  if (ts.isConditionalExpression(expression)) {
    const decision = conditionValue(expression.condition, scope, seen);
    if (decision === true)
      return evalValue(
        expression.whenTrue,
        scope,
        seen,
        functions,
        diagnostics,
      );
    if (decision === false)
      return evalValue(
        expression.whenFalse,
        scope,
        seen,
        functions,
        diagnostics,
      );
    return [
      ...evalValue(expression.whenTrue, scope, seen, functions, diagnostics),
      ...evalValue(expression.whenFalse, scope, seen, functions, diagnostics),
    ];
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const properties = new Map<string, StaticValue>();
    let hasUnknownSpread = false;
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = evalValue(
          property.expression,
          scope,
          seen,
          functions,
          diagnostics,
        );
        for (const value of spread) {
          if (
            typeof value === "object" &&
            value !== null &&
            value.kind === "object"
          ) {
            for (const [name, item] of value.properties)
              properties.set(name, item);
            hasUnknownSpread ||= value.hasUnknownSpread;
          } else {
            hasUnknownSpread = true;
          }
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const values = evalValue(
          property.name,
          scope,
          seen,
          functions,
          diagnostics,
        );
        properties.set(
          property.name.text,
          values.length === 1 ? values[0]! : dynamic(property.name.text),
        );
        continue;
      }
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyName(property.name);
      if (name === null) continue;
      const values = evalValue(
        property.initializer,
        scope,
        seen,
        functions,
        diagnostics,
      );
      properties.set(name, values.length === 1 ? values[0]! : dynamic(name));
    }
    return [{ kind: "object", properties, hasUnknownSpread }];
  }
  if (ts.isArrayLiteralExpression(expression))
    return [
      dynamic(`array:${expression.getText(scope.descriptor.sourceFile)}`),
    ];
  if (ts.isCallExpression(expression)) {
    const name = calleeName(expression.expression);
    if (name && functions.has(name)) {
      const args = expression.arguments.map((argument) => {
        const values = evalValue(argument, scope, seen, functions, diagnostics);
        return values.length === 1 ? values[0]! : dynamic(name);
      });
      return functionReturns(
        functions.get(name)!,
        args,
        functions,
        "value",
        diagnostics,
        seen,
      );
    }
    if (
      name === "parse" ||
      name === "encodeURIComponent" ||
      name === "String"
    ) {
      const values = expression.arguments.flatMap((argument) =>
        evalValue(argument, scope, seen, functions, diagnostics),
      );
      if (values.length > 0) return values;
    }
    return [
      dynamic(
        name ?? expression.expression.getText(scope.descriptor.sourceFile),
      ),
    ];
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evalValue(
      expression.left,
      scope,
      seen,
      functions,
      diagnostics,
    );
    const right = evalValue(
      expression.right,
      scope,
      seen,
      functions,
      diagnostics,
    );
    return left.flatMap((first) =>
      right.map((second) =>
        typeof first === "string" && typeof second === "string"
          ? first + second
          : dynamic("concatenated value"),
      ),
    );
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const decision = conditionValue(expression.operand, scope, seen);
    return [decision === null ? dynamic("boolean expression") : !decision];
  }
  return [dynamic(expression.getText(scope.descriptor.sourceFile))];
}

function pathFromTemplate(
  expression: ts.TemplateExpression,
  scope: Scope,
  functions: Map<string, FunctionDescriptor>,
  diagnostics: string[],
  recursion: Set<string>,
): string[] {
  let prefixes = [expression.head.text];
  const initialQuery = prefixes[0]!.indexOf("?");
  if (initialQuery >= 0) return [prefixes[0]!.slice(0, initialQuery)];
  for (const span of expression.templateSpans) {
    const values = evalPath(
      span.expression,
      scope,
      functions,
      diagnostics,
      recursion,
    );
    const additions: string[] = [];
    for (const value of values) {
      if (typeof value === "string") additions.push(value);
      else if (
        typeof value === "object" &&
        value !== null &&
        value.kind === "dynamic" &&
        value.isRouteParameter
      )
        additions.push("{param}");
      else {
        diagnostics.push(
          `unresolved dynamic path interpolation "${span.expression.getText(scope.descriptor.sourceFile)}" in ${scope.descriptor.name}`,
        );
      }
    }
    prefixes = prefixes.flatMap((prefix) =>
      additions.map((value) => prefix + value),
    );
    const tail = span.literal.text;
    prefixes = prefixes.map((prefix) => {
      const query = tail.indexOf("?");
      return prefix + (query < 0 ? tail : tail.slice(0, query));
    });
    if (tail.includes("?")) return prefixes;
  }
  return prefixes;
}

function evalPath(
  expression: ts.Expression,
  scope: Scope,
  functions: Map<string, FunctionDescriptor>,
  diagnostics: string[],
  recursion = new Set<string>(),
): StaticValue[] {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    return evalPath(
      expression.expression,
      scope,
      functions,
      diagnostics,
      recursion,
    );
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  )
    return [expression.text.split("?", 1)[0]!];
  if (ts.isTemplateExpression(expression))
    return pathFromTemplate(
      expression,
      scope,
      functions,
      diagnostics,
      recursion,
    );
  if (ts.isIdentifier(expression)) {
    if (scope.parameters.has(expression.text))
      return [scope.parameters.get(expression.text)!];
    const binding = scope.bindings.get(expression.text);
    if (binding === undefined)
      return [dynamic(expression.text, routeParameterName(expression.text))];
    if (isStaticValue(binding)) return [binding];
    return evalPath(
      binding as ts.Expression,
      scope,
      functions,
      diagnostics,
      recursion,
    );
  }
  if (ts.isConditionalExpression(expression)) {
    const decision = conditionValue(expression.condition, scope, recursion);
    if (decision === true)
      return evalPath(
        expression.whenTrue,
        scope,
        functions,
        diagnostics,
        recursion,
      );
    if (decision === false)
      return evalPath(
        expression.whenFalse,
        scope,
        functions,
        diagnostics,
        recursion,
      );
    return [
      ...evalPath(
        expression.whenTrue,
        scope,
        functions,
        diagnostics,
        recursion,
      ),
      ...evalPath(
        expression.whenFalse,
        scope,
        functions,
        diagnostics,
        recursion,
      ),
    ];
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evalPath(
      expression.left,
      scope,
      functions,
      diagnostics,
      recursion,
    );
    const leftStrings = left.filter(
      (value): value is string => typeof value === "string",
    );
    if (leftStrings.some((value) => value.includes("?")))
      return leftStrings.map((value) => value.split("?", 1)[0]!);
    const right = evalPath(
      expression.right,
      scope,
      functions,
      diagnostics,
      recursion,
    );
    return left.flatMap((first) =>
      right.map((second) =>
        typeof first === "string" && typeof second === "string"
          ? (first + second).split("?", 1)[0]!
          : dynamic("concatenated route path"),
      ),
    );
  }
  if (ts.isCallExpression(expression)) {
    const name = calleeName(expression.expression);
    if (name && functions.has(name)) {
      const args = expression.arguments.map((argument) => {
        const values = evalPath(
          argument,
          scope,
          functions,
          diagnostics,
          recursion,
        );
        return values.length === 1 ? values[0]! : dynamic(name);
      });
      return functionReturns(
        functions.get(name)!,
        args,
        functions,
        "path",
        diagnostics,
        recursion,
      );
    }
    const values = evalValue(
      expression,
      scope,
      recursion,
      functions,
      diagnostics,
    );
    if (
      values.length > 0 &&
      values.every(
        (value) =>
          typeof value === "string" ||
          (typeof value === "object" &&
            value !== null &&
            value.kind === "dynamic" &&
            value.isRouteParameter),
      )
    )
      return values;
    diagnostics.push(
      `unresolved dynamic request path call "${expression.expression.getText(scope.descriptor.sourceFile)}" in ${scope.descriptor.name}`,
    );
    return [dynamic(name ?? "unknown path call")];
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const values = evalValue(
      expression,
      scope,
      recursion,
      functions,
      diagnostics,
    );
    return values;
  }
  const values = evalValue(
    expression,
    scope,
    recursion,
    functions,
    diagnostics,
  );
  return values;
}

function routeShape(path: string): string {
  return path
    .split("?", 1)[0]!
    .replace(/\{[a-zA-Z0-9_]+\}/g, "{}")
    .replace(/\{param\}/g, "{}");
}

function routePath(
  expression: ts.Expression | undefined,
  signature: RequestSignature,
  scope: Scope,
  functions: Map<string, FunctionDescriptor>,
  diagnostics: string[],
): string[] {
  if (!expression) {
    diagnostics.push(
      `request path argument is missing in ${scope.descriptor.name}`,
    );
    return [];
  }
  const rawValues = evalPath(expression, scope, functions, diagnostics);
  const results: string[] = [];
  for (const value of rawValues) {
    if (typeof value !== "string") {
      diagnostics.push(
        `unresolved dynamic request path "${expression.getText(scope.descriptor.sourceFile)}" in ${scope.descriptor.name}`,
      );
      continue;
    }
    const path = value.split("?", 1)[0]!;
    const fullPath =
      signature.prefix === "api" && !path.startsWith("/api/")
        ? `/api${path}`
        : path;
    if (!fullPath.startsWith("/api/")) {
      diagnostics.push(
        `request path does not resolve to /api/: "${fullPath}" in ${scope.descriptor.name}`,
      );
      continue;
    }
    results.push(fullPath);
  }
  return [...new Set(results)];
}

function objectProperty(
  value: StaticValue,
  name: string,
): StaticValue | undefined {
  if (typeof value === "object" && value !== null && value.kind === "object")
    return value.properties.get(name);
  return undefined;
}

function requestMethods(
  call: ts.CallExpression,
  signature: RequestSignature,
  scope: Scope,
  functions: Map<string, FunctionDescriptor>,
  diagnostics: string[],
): string[] {
  if (
    signature.initArgument === null ||
    !call.arguments[signature.initArgument]
  )
    return ["GET"];
  const initValues = evalValue(
    call.arguments[signature.initArgument]!,
    scope,
    new Set(),
    functions,
    diagnostics,
  );
  const methods: string[] = [];
  for (const init of initValues) {
    const value = objectProperty(init, "method");
    if (value === undefined) {
      if (
        typeof init === "object" &&
        init !== null &&
        init.kind === "object" &&
        !init.hasUnknownSpread
      ) {
        methods.push("GET");
      } else {
        diagnostics.push(
          `unresolved request method in ${scope.descriptor.name}`,
        );
      }
    } else if (typeof value === "string") {
      methods.push(value.toUpperCase());
    } else {
      diagnostics.push(`unresolved request method in ${scope.descriptor.name}`);
    }
  }
  return [...new Set(methods)];
}

function sourceFunctions(
  modules: Map<string, ts.SourceFile>,
): Map<string, Map<string, FunctionDescriptor>> {
  return localFunctions(modules);
}

function directRequestNodes(root: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && REQUEST_SIGNATURES.has(name)) result.push(node);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "EventSource"
    )
      result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}

function pathParameterIndexes(descriptor: FunctionDescriptor): number[] {
  return descriptor.node.parameters.flatMap((parameter, index) =>
    ts.isIdentifier(parameter.name) &&
    /(?:path|url)$/i.test(parameter.name.text)
      ? [index]
      : [],
  );
}

function functionReachesRequest(
  descriptor: FunctionDescriptor,
  fileFunctions: Map<string, FunctionDescriptor>,
  seen = new Set<string>(),
): boolean {
  const key = `${descriptor.file}:${descriptor.name}`;
  if (seen.has(key)) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(key);
  const body = functionBody(descriptor);
  if (!body) return false;
  for (const node of directRequestNodes(body)) {
    if (ts.isCallExpression(node)) {
      if (
        calleeName(node.expression) === "sendApiRequest" &&
        descriptor.name === "apiRequest"
      )
        continue;
      return true;
    }
    if (ts.isNewExpression(node)) return true;
  }
  let reached = false;
  const visit = (node: ts.Node): void => {
    if (reached || (node !== body && isFunctionLike(node))) return;
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const helper = name ? fileFunctions.get(name) : undefined;
      if (
        helper &&
        !GENERIC_WRAPPERS.has(helper.name) &&
        functionReachesRequest(helper, fileFunctions, nextSeen)
      ) {
        reached = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return reached;
}

function scanOwner(
  owner: FunctionDescriptor,
  fileFunctions: Map<string, FunctionDescriptor>,
  routes: FrontendRoute[],
  visited: Set<ts.Node>,
  diagnostics: string[],
  privateDirectOnly = false,
): void {
  const stack = new Set<string>();
  const visitFunction = (
    descriptor: FunctionDescriptor,
    args: StaticValue[],
    depth: number,
    directOnly: boolean,
  ): void => {
    if (depth > 20) {
      diagnostics.push(
        `request helper nesting exceeds 20 levels at ${descriptor.name}`,
      );
      return;
    }
    const key = `${descriptor.file}:${descriptor.name}:${args.map(String).join(",")}`;
    if (stack.has(key)) return;
    stack.add(key);
    const scope = makeScope(descriptor, args);
    const body = functionBody(descriptor);
    if (!body) return;
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        const signature = name ? REQUEST_SIGNATURES.get(name) : undefined;
        if (
          signature &&
          !(name === "sendApiRequest" && descriptor.name === "apiRequest")
        ) {
          visited.add(node);
          const paths = routePath(
            node.arguments[signature.pathArgument],
            signature,
            scope,
            fileFunctions,
            diagnostics,
          );
          const methods = requestMethods(
            node,
            signature,
            scope,
            fileFunctions,
            diagnostics,
          );
          for (const path of paths) {
            for (const method of methods) {
              routes.push({
                adapter: descriptor.file,
                function: owner.name,
                method,
                path,
              });
            }
          }
        } else if (!directOnly && name) {
          const helper = fileFunctions.get(name);
          if (
            helper &&
            !GENERIC_WRAPPERS.has(helper.name) &&
            functionReachesRequest(helper, fileFunctions)
          ) {
            if (pathParameterIndexes(helper).length > 0) visited.add(node);
            const helperArgs: StaticValue[] = [];
            for (const [index, parameter] of helper.node.parameters.entries()) {
              const argument = node.arguments[index] ?? parameter.initializer;
              const parameterName = ts.isIdentifier(parameter.name)
                ? parameter.name.text
                : "";
              if (!argument) {
                helperArgs.push(
                  dynamic(parameterName, routeParameterName(parameterName)),
                );
                continue;
              }
              const argumentScope = node.arguments[index]
                ? scope
                : makeScope(helper, helperArgs);
              const isPathArgument = /(?:path|url)$/i.test(parameterName);
              const values = isPathArgument
                ? evalPath(argument, argumentScope, fileFunctions, diagnostics)
                : evalValue(
                    argument,
                    argumentScope,
                    new Set(),
                    fileFunctions,
                    diagnostics,
                  );
              helperArgs.push(values.length === 1 ? values[0]! : dynamic(name));
            }
            visitFunction(helper, helperArgs, depth + 1, false);
          }
        }
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "EventSource"
      ) {
        visited.add(node);
        const path = routePath(
          node.arguments?.[0],
          { pathArgument: 0, initArgument: null, prefix: "none" },
          scope,
          fileFunctions,
          diagnostics,
        );
        for (const route of path)
          routes.push({
            adapter: descriptor.file,
            function: owner.name,
            method: "GET",
            path: route,
          });
      }
      ts.forEachChild(node, walk);
    };
    walk(body);
    stack.delete(key);
  };
  visitFunction(owner, [], 0, privateDirectOnly);
}

function ownerFunctions(
  functions: Map<string, Map<string, FunctionDescriptor>>,
): Array<{ descriptor: FunctionDescriptor; privateDirectOnly: boolean }> {
  const owners: Array<{
    descriptor: FunctionDescriptor;
    privateDirectOnly: boolean;
  }> = [];
  for (const fileFunctions of functions.values()) {
    for (const descriptor of fileFunctions.values()) {
      if (
        descriptor.exported &&
        isAdapterSource(descriptor.file) &&
        !GENERIC_WRAPPERS.has(descriptor.name)
      )
        owners.push({ descriptor, privateDirectOnly: false });
      if (
        descriptor.file === "frontend/src/lib/api.ts" &&
        !descriptor.exported &&
        descriptor.name !== "sendApiRequest" &&
        directRequestNodes(functionBody(descriptor) ?? descriptor.node).some(
          (node) =>
            ts.isCallExpression(node) &&
            calleeName(node.expression) === "sendApiRequest",
        )
      )
        owners.push({ descriptor, privateDirectOnly: true });
    }
  }
  return owners;
}

function nearestFunctionName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionLike(current)) {
      if (current.name && ts.isIdentifier(current.name))
        return current.name.text;
      let parent = current.parent;
      while (parent && !ts.isVariableDeclaration(parent))
        parent = parent.parent;
      if (
        parent &&
        ts.isVariableDeclaration(parent) &&
        ts.isIdentifier(parent.name)
      )
        return parent.name.text;
    }
    current = current.parent;
  }
  return null;
}

function allRequestNodes(
  modules: Map<string, ts.SourceFile>,
  functions: Map<string, Map<string, FunctionDescriptor>>,
): ts.Node[] {
  const nodes = [...modules.values()].flatMap((sourceFile) =>
    directRequestNodes(sourceFile),
  );
  for (const [file, sourceFile] of modules) {
    const fileFunctions = functions.get(file) ?? new Map();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        const helper = name ? fileFunctions.get(name) : undefined;
        if (
          helper &&
          !REQUEST_SIGNATURES.has(helper.name) &&
          pathParameterIndexes(helper).length > 0 &&
          functionReachesRequest(helper, fileFunctions)
        )
          nodes.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...new Set(nodes)];
}

function makeModules(inputs: SourceModule[]): Map<string, ts.SourceFile> {
  return new Map(
    inputs.map(({ file, source }) => [
      file,
      ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKind(file),
      ),
    ]),
  );
}

function scanModules(modules: Map<string, ts.SourceFile>): RouteScan {
  const functions = sourceFunctions(modules);
  const routes: FrontendRoute[] = [];
  const diagnostics: string[] = [];
  const visited = new Set<ts.Node>();
  for (const owner of ownerFunctions(functions)) {
    const fileFunctions = functions.get(owner.descriptor.file)!;
    const hasRouteCall =
      owner.privateDirectOnly ||
      functionReachesRequest(owner.descriptor, fileFunctions);
    if (hasRouteCall)
      scanOwner(
        owner.descriptor,
        fileFunctions,
        routes,
        visited,
        diagnostics,
        owner.privateDirectOnly,
      );
  }
  for (const node of allRequestNodes(modules, functions)) {
    if (visited.has(node)) continue;
    const functionName = nearestFunctionName(node);
    if (functionName && GENERIC_IMPLEMENTATIONS.has(functionName)) continue;
    if (functionName === "apiRequest") continue;
    const sourceFile = node.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    diagnostics.push(
      `unowned request call at ${sourceFile.fileName}:${position.line + 1} (${functionName ?? "module scope"})`,
    );
  }
  const unique = new Map<string, FrontendRoute>();
  for (const route of routes) {
    const key = `${route.adapter}\u0000${route.function}\u0000${route.method}\u0000${routeShape(route.path)}`;
    unique.set(key, route);
  }
  return {
    routes: [...unique.values()].sort(compareRoutes),
    diagnostics: [...new Set(diagnostics)].sort(),
  };
}

function compareRoutes(left: FrontendRoute, right: FrontendRoute): number {
  return (
    left.adapter.localeCompare(right.adapter) ||
    left.function.localeCompare(right.function) ||
    left.method.localeCompare(right.method) ||
    routeShape(left.path).localeCompare(routeShape(right.path))
  );
}

function sourceModulesFromDisk(sourceRoot: string): SourceModule[] {
  const paths = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return paths(path);
      if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts"))
        return [];
      return [path];
    });
  return paths(sourceRoot).map((path) => ({
    file: `frontend/${relative(FRONTEND_ROOT, path).replaceAll("\\", "/")}`,
    source: readFileSync(path, "utf8"),
  }));
}

export function discoverFrontendRoutes(
  sourceRoot = resolve(FRONTEND_ROOT, "src"),
): RouteScan {
  return scanModules(makeModules(sourceModulesFromDisk(sourceRoot)));
}

export function discoverRoutesInSources(sources: SourceModule[]): RouteScan {
  return scanModules(makeModules(sources));
}

export function manifestDifferences(
  discovered: FrontendRoute[],
  manifest: FrontendRoute[],
): { missing: FrontendRoute[]; extra: FrontendRoute[] } {
  const key = (route: FrontendRoute) =>
    `${route.adapter}\u0000${route.function}\u0000${route.method}\u0000${routeShape(route.path)}`;
  const actual = new Map(discovered.map((route) => [key(route), route]));
  const declared = new Map(manifest.map((route) => [key(route), route]));
  return {
    missing: [...actual.entries()]
      .filter(([routeKey]) => !declared.has(routeKey))
      .map(([, route]) => route)
      .sort(compareRoutes),
    extra: [...declared.entries()]
      .filter(([routeKey]) => !actual.has(routeKey))
      .map(([, route]) => route)
      .sort(compareRoutes),
  };
}

export function manifestSchemaErrors(value: unknown): string[] {
  if (!Array.isArray(value)) return ["route manifest must be an array"];
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).adapter !== "string" ||
      typeof (item as Record<string, unknown>).function !== "string" ||
      typeof (item as Record<string, unknown>).method !== "string" ||
      typeof (item as Record<string, unknown>).path !== "string"
    ) {
      errors.push(
        `route manifest entry ${index} must define adapter, function, method, and path`,
      );
      continue;
    }
    const route = item as FrontendRoute;
    if (!route.adapter.startsWith("frontend/src/"))
      errors.push(
        `route manifest entry ${index} must identify an adapter under frontend/src`,
      );
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(route.method))
      errors.push(
        `route manifest entry ${index} has unsupported method ${route.method}`,
      );
    if (!route.path.startsWith("/api/"))
      errors.push(`route manifest entry ${index} path must start with /api/`);
    if (/[{}]/.test(route.path.replace(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g, "")))
      errors.push(
        `route manifest entry ${index} has a malformed path parameter`,
      );
    const key = `${route.adapter}\u0000${route.function}\u0000${route.method}\u0000${routeShape(route.path)}`;
    if (keys.has(key))
      errors.push(`route manifest entry ${index} duplicates ${route.function}`);
    keys.add(key);
  }
  return errors;
}
