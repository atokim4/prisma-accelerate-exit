import {
  type CallExpression,
  type Identifier,
  type ImportDeclaration,
  Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from "ts-morph";
import { EXTENSION_PACKAGE } from "./project.js";
import { removeListElement, removeNode, replaceNode, type TextEdit } from "./text-edit.js";
import type { AdapterName, Finding } from "./types.js";

const PRISMA_READ_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "$queryRaw",
  "$queryRawUnsafe",
  "$queryRawTyped",
]);

export const ADAPTERS: Record<AdapterName, { pkg: string; className: string; construct: (url: string) => string }> = {
  pg: { pkg: "@prisma/adapter-pg", className: "PrismaPg", construct: (url) => `new PrismaPg({ connectionString: ${url} })` },
  ppg: { pkg: "@prisma/adapter-ppg", className: "PrismaPostgresAdapter", construct: (url) => `new PrismaPostgresAdapter({ connectionString: ${url} })` },
  mariadb: { pkg: "@prisma/adapter-mariadb", className: "PrismaMariaDb", construct: (url) => `new PrismaMariaDb(${url})` },
};

/** One planned fix as text edits on the original file; applied only when the run may fix that kind. */
export interface SourceEdit {
  finding: Finding;
  edits: TextEdit[];
}

export interface SourceAnalysis {
  findings: Finding[];
  /** Removes the extension: imports, requires, `$extends(withAccelerate())`. */
  extensionEdits: SourceEdit[];
  cacheEdits: SourceEdit[];
  adapterEdits: SourceEdit[];
  edgeImportEdits: SourceEdit[];
  /** Something references the extension in a way the fixer will not rewrite. */
  blocksExtensionRemoval: string[];
  usesAccelerate: boolean;
  isEdgeEntry: boolean;
}

function lineOf(node: Node): number {
  return node.getStartLineNumber();
}

function snippetOf(node: Node): string {
  const text = node.getText().replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function finding(file: string, node: Node, partial: Omit<Finding, "file" | "line" | "snippet">): Finding {
  return { ...partial, file, line: lineOf(node), snippet: snippetOf(node) };
}

function isExtensionSpecifier(text: string): boolean {
  return text === EXTENSION_PACKAGE || text.startsWith(`${EXTENSION_PACKAGE}/`);
}

function isRequireOf(node: Node | undefined, check: (spec: string) => boolean): boolean {
  if (!node || !Node.isCallExpression(node)) return false;
  const callee = node.getExpression();
  const [arg] = node.getArguments();
  return Node.isIdentifier(callee) && callee.getText() === "require" && !!arg && Node.isStringLiteral(arg) && check(arg.getLiteralValue());
}

/** `x.$extends(withAccelerate(...))` where the extension call is the only argument. */
function extendsCallAround(useSite: Identifier): CallExpression | null {
  const inner = useSite.getParent();
  if (!inner || !Node.isCallExpression(inner) || inner.getExpression() !== useSite) return null;
  const outer = inner.getParent();
  if (!outer || !Node.isCallExpression(outer)) return null;
  const args = outer.getArguments();
  if (args.length !== 1 || args[0] !== inner) return null;
  const callee = outer.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "$extends") return null;
  return outer;
}

/** The client expression `$extends` is called on. */
function receiverOf(extendsCall: CallExpression): Node {
  const callee = extendsCall.getExpression();
  return Node.isPropertyAccessExpression(callee) ? callee.getExpression() : callee;
}

function isPlainReference(node: Node): boolean {
  return Node.isIdentifier(node) || Node.isThisExpression(node) || (Node.isPropertyAccessExpression(node) && isPlainReference(node.getExpression()));
}

function unwrapParentheses(node: Node): Node {
  let current = node;
  while (Node.isParenthesizedExpression(current)) current = current.getExpression();
  return current;
}

/**
 * Drops `.$extends(withAccelerate())`. When the call is one branch of
 * `flag ? client.$extends(withAccelerate()) : client`, both branches would end up
 * identical, so the whole conditional collapses to `client`.
 */
function removeExtendsEdit(extendsCall: CallExpression): TextEdit {
  const receiver = receiverOf(extendsCall);
  let branch: Node = extendsCall;
  while (Node.isParenthesizedExpression(branch.getParent())) branch = branch.getParentOrThrow();
  const conditional = branch.getParent();
  if (conditional && Node.isConditionalExpression(conditional) && isPlainReference(receiver) && isPlainReference(unwrapParentheses(conditional.getCondition()))) {
    const other = conditional.getWhenTrue() === branch ? conditional.getWhenFalse() : conditional.getWhenTrue();
    if (unwrapParentheses(other).getText() === receiver.getText()) {
      let outer: Node = conditional;
      while (Node.isParenthesizedExpression(outer.getParent())) outer = outer.getParentOrThrow();
      return { start: outer.getStart(), end: outer.getEnd(), text: receiver.getText() };
    }
  }
  return { start: receiver.getEnd(), end: extendsCall.getEnd(), text: "" };
}

function removeRequire(declaration: VariableDeclaration): TextEdit {
  const statement = declaration.getVariableStatement();
  if (statement && statement.getDeclarations().length === 1) return removeNode(statement);
  const list = declaration.getParentIfKind(SyntaxKind.VariableDeclarationList);
  return list ? removeListElement(declaration, list.getDeclarations()) : removeNode(declaration);
}

function isEdgeRuntimeExport(sourceFile: SourceFile): boolean {
  for (const statement of sourceFile.getVariableStatements()) {
    if (!statement.isExported()) continue;
    for (const declaration of statement.getDeclarations()) {
      const init = declaration.getInitializer();
      if (declaration.getName() === "runtime" && init && Node.isStringLiteral(init) && /edge/.test(init.getLiteralValue())) {
        return true;
      }
    }
  }
  return false;
}

function isPrismaReadCall(call: CallExpression): boolean {
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee) && PRISMA_READ_OPS.has(callee.getName());
}

/** The statement to delete when a `$accelerate.invalidate*()` call is dropped, if it stands alone. */
function standaloneStatement(call: CallExpression): Node | null {
  let node: Node = call;
  const parent = node.getParent();
  if (parent && Node.isAwaitExpression(parent)) node = parent;
  const statement = node.getParent();
  return statement && Node.isExpressionStatement(statement) ? statement : null;
}

function removeObjectProperty(property: Node): TextEdit {
  const object = property.getParentIfKind(SyntaxKind.ObjectLiteralExpression);
  if (!object) return removeNode(property);
  const properties = object.getProperties();
  const call = object.getParentIfKind(SyntaxKind.CallExpression) ?? object.getParentIfKind(SyntaxKind.NewExpression);
  if (properties.length === 1) {
    const args = call?.getArguments() ?? [];
    return args.length === 1 && args[0] === object ? replaceNode(object, "") : replaceNode(object, "{}");
  }
  return removeListElement(property, properties);
}

/** `import { X } from "pkg";` placed after the last import, in the file's quote and semicolon style. */
function addImportEdit(sourceFile: SourceFile, moduleName: string, name: string): TextEdit {
  const imports = sourceFile.getImportDeclarations();
  const sample = imports[0]?.getText() ?? "";
  const quote = sample.includes("'") && !sample.includes('"') ? "'" : '"';
  const semi = sample === "" || sample.trimEnd().endsWith(";") ? ";" : "";
  const statement = `import { ${name} } from ${quote}${moduleName}${quote}${semi}`;
  const kept = imports.filter((d) => !isExtensionSpecifier(d.getModuleSpecifierValue()));
  const last = kept[kept.length - 1];
  if (last) return { start: last.getEnd(), end: last.getEnd(), text: `\n${statement}` };
  const first = imports[0];
  const at = first ? removeNode(first).start : 0;
  return { start: at, end: at, text: `${statement}\n` };
}

function hasNamedImport(sourceFile: SourceFile, moduleName: string, name: string): boolean {
  return sourceFile
    .getImportDeclarations()
    .some((decl) => decl.getModuleSpecifierValue() === moduleName && decl.getNamedImports().some((n) => n.getName() === name));
}

export function analyzeSource(sourceFile: SourceFile, file: string, ormMajor: number | null, adapter: AdapterName | undefined): SourceAnalysis {
  const result: SourceAnalysis = {
    findings: [],
    extensionEdits: [],
    cacheEdits: [],
    adapterEdits: [],
    edgeImportEdits: [],
    blocksExtensionRemoval: [],
    usesAccelerate: false,
    isEdgeEntry: isEdgeRuntimeExport(sourceFile),
  };
  const text = sourceFile.getFullText();
  const block = (node: Node, why: string) => result.blocksExtensionRemoval.push(`${file}:${lineOf(node)} ${why}`);

  // (b) imports and requires of the extension package
  const extensionLocals: string[] = [];
  for (const decl of sourceFile.getImportDeclarations()) {
    if (!isExtensionSpecifier(decl.getModuleSpecifierValue())) continue;
    result.usesAccelerate = true;
    collectImport(decl);
  }
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (!isRequireOf(declaration.getInitializer(), isExtensionSpecifier)) continue;
    result.usesAccelerate = true;
    collectRequire(declaration);
  }
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
    const [arg] = call.getArguments();
    if (arg && Node.isStringLiteral(arg) && isExtensionSpecifier(arg.getLiteralValue())) {
      result.usesAccelerate = true;
      result.findings.push(finding(file, call, { rule: "extension-other-use", severity: "action", fix: "manual", message: "Dynamic import of the Accelerate extension. Remove it by hand." }));
      block(call, "dynamic import of the extension");
    }
  }

  function collectImport(decl: ImportDeclaration): void {
    const named = decl.getNamedImports();
    const others = named.filter((n) => n.getName() !== "withAccelerate");
    if (decl.getDefaultImport() || decl.getNamespaceImport() || others.length > 0 || named.length === 0) {
      result.findings.push(
        finding(file, decl, {
          rule: "extension-other-use",
          severity: "action",
          fix: "manual",
          message: `Imports more than withAccelerate from ${EXTENSION_PACKAGE}. Replace those types or helpers before uninstalling the package.`,
        }),
      );
      block(decl, "imports other names from the extension");
    }
    const withAccelerate = named.find((n) => n.getName() === "withAccelerate");
    if (!withAccelerate) return;
    extensionLocals.push((withAccelerate.getAliasNode() ?? withAccelerate.getNameNode()).getText());
    const edit: SourceEdit = {
      finding: finding(file, decl, { rule: "extension-import", severity: "action", fix: "auto", message: "Import of withAccelerate." }),
      edits: [others.length === 0 && !decl.getDefaultImport() && !decl.getNamespaceImport() ? removeNode(decl) : removeListElement(withAccelerate, named)],
    };
    result.findings.push(edit.finding);
    result.extensionEdits.push(edit);
  }

  function collectRequire(declaration: VariableDeclaration): void {
    const nameNode = declaration.getNameNode();
    const binding = Node.isObjectBindingPattern(nameNode)
      ? nameNode.getElements().find((el) => (el.getPropertyNameNode()?.getText() ?? el.getName()) === "withAccelerate")
      : undefined;
    const onlyBinding = Node.isObjectBindingPattern(nameNode) && nameNode.getElements().length === 1;
    if (!binding || !onlyBinding) {
      result.findings.push(finding(file, declaration, { rule: "extension-other-use", severity: "action", fix: "manual", message: `require() of ${EXTENSION_PACKAGE} in a form the fixer does not rewrite.` }));
      block(declaration, "require() of the extension");
      if (!binding) return;
    }
    extensionLocals.push(binding.getName());
    const edit: SourceEdit = {
      finding: finding(file, declaration, { rule: "extension-import", severity: "action", fix: "auto", message: "require() of withAccelerate." }),
      edits: [removeRequire(declaration)],
    };
    if (onlyBinding) {
      result.findings.push(edit.finding);
      result.extensionEdits.push(edit);
    }
  }

  // (b) every use of the local withAccelerate binding must be `.$extends(withAccelerate())`
  const localNames = new Set(extensionLocals);
  if (localNames.size > 0) {
    for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (!localNames.has(id.getText())) continue;
      const parent = id.getParent();
      if (parent && (Node.isImportSpecifier(parent) || Node.isBindingElement(parent))) continue;
      if (parent && Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) continue;
      if (parent && (Node.isPropertyAssignment(parent) || Node.isMethodDeclaration(parent) || Node.isPropertySignature(parent)) && parent.getNameNode() === id) continue;
      const extendsCall = extendsCallAround(id);
      if (!extendsCall) {
        result.findings.push(finding(file, id.getParent() ?? id, { rule: "extension-other-use", severity: "action", fix: "manual", message: "withAccelerate is used outside a plain .$extends(withAccelerate()) call." }));
        block(id, "withAccelerate used outside .$extends()");
        continue;
      }
      const edit: SourceEdit = {
        finding: finding(file, extendsCall, { rule: "extends-call", severity: "action", fix: "auto", message: ".$extends(withAccelerate()) on the Prisma Client." }),
        edits: [removeExtendsEdit(extendsCall)],
      };
      result.findings.push(edit.finding);
      result.extensionEdits.push(edit);
    }
  }

  // new PrismaClient({ accelerateUrl }) (ORM 7)
  for (const expr of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    if (!/PrismaClient$/.test(expr.getExpression().getText())) continue;
    const [options] = expr.getArguments();
    if (!options || !Node.isObjectLiteralExpression(options)) continue;
    const property = options.getProperty("accelerateUrl");
    if (!property) continue;
    result.usesAccelerate = true;
    collectAccelerateUrl(options, property);
  }

  function collectAccelerateUrl(options: ObjectLiteralExpression, property: Node): void {
    const hasAdapter = !!options.getProperty("adapter");
    const value = Node.isPropertyAssignment(property)
      ? property.getInitializer()?.getText()
      : Node.isShorthandPropertyAssignment(property)
        ? property.getName()
        : undefined;
    if (hasAdapter || value === undefined || adapter === undefined) {
      result.findings.push(
        finding(file, property, {
          rule: "accelerate-url-option",
          severity: "action",
          fix: value === undefined ? "manual" : "adapter",
          message: hasAdapter
            ? "accelerateUrl next to an adapter: delete accelerateUrl once the adapter path is the only one."
            : "accelerateUrl routes the client through Accelerate. Prisma ORM 7 needs a driver adapter instead; rerun with --fix --adapter pg|mariadb|ppg.",
        }),
      );
      return;
    }
    const spec = ADAPTERS[adapter];
    const edit: SourceEdit = {
      finding: finding(file, property, { rule: "accelerate-url-option", severity: "action", fix: "adapter", message: `accelerateUrl replaced with a ${spec.className} driver adapter.` }),
      edits: [
        replaceNode(property, `adapter: ${spec.construct(value)}`),
        ...(hasNamedImport(sourceFile, spec.pkg, spec.className) ? [] : [addImportEdit(sourceFile, spec.pkg, spec.className)]),
      ],
    };
    result.findings.push(edit.finding);
    result.adapterEdits.push(edit);
  }

  // @prisma/client/edge
  for (const decl of sourceFile.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    if (spec !== "@prisma/client/edge" && spec !== "@prisma/client/edge.js") continue;
    const autoFix = ormMajor !== null && ormMajor <= 6;
    const edit: SourceEdit = {
      finding: finding(file, decl, {
        rule: "edge-client-import",
        severity: "action",
        fix: autoFix ? "auto" : "manual",
        message: autoFix
          ? "Imports the engine-less edge client. With the bundled engine on ORM 6, import from @prisma/client."
          : "Imports @prisma/client/edge. On ORM 7, import from your generator output and pass a driver adapter.",
      }),
      edits: [replaceNode(decl.getModuleSpecifier(), `${decl.getModuleSpecifier().getText()[0]}@prisma/client${decl.getModuleSpecifier().getText()[0]}`)],
    };
    result.findings.push(edit.finding);
    if (autoFix) result.edgeImportEdits.push(edit);
  }


  // (c) caching APIs: cacheStrategy, $accelerate.invalidate*, withAccelerateInfo
  if (/cacheStrategy|\$accelerate|withAccelerateInfo/.test(text)) collectCacheApis();

  function collectCacheApis(): void {
    for (const property of sourceFile.getDescendants()) {
      if (!(Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property))) continue;
      if (property.getName() !== "cacheStrategy") continue;
      const object = property.getParentIfKind(SyntaxKind.ObjectLiteralExpression);
      const call = object?.getParentIfKind(SyntaxKind.CallExpression);
      const directQueryArg = !!call && isPrismaReadCall(call) && call.getArguments()[0] === object;
      const edit: SourceEdit = {
        finding: finding(file, property, {
          rule: "cache-strategy",
          severity: "action",
          fix: directQueryArg ? "drop-cache" : "manual",
          message: directQueryArg
            ? "cacheStrategy on a query. Without Accelerate this query hits the database every time: decide on a replacement cache, or drop it with --drop-cache."
            : "cacheStrategy built outside the query call. Remove it where the query args are assembled.",
        }),
        edits: [removeObjectProperty(property)],
      };
      result.findings.push(edit.finding);
      if (directQueryArg) result.cacheEdits.push(edit);
      else block(property, "cacheStrategy outside a query call");
    }

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const name = callee.getName();
      if (name === "withAccelerateInfo") {
        result.findings.push(
          finding(file, call, {
            rule: "accelerate-info",
            severity: "action",
            fix: "manual",
            message: ".withAccelerateInfo() returns { data, info }. Callers must be rewritten to use the plain result.",
          }),
        );
        block(call, ".withAccelerateInfo() changes the result shape");
        continue;
      }
      if (name !== "invalidate" && name !== "invalidateAll") continue;
      const target = callee.getExpression();
      if (!Node.isPropertyAccessExpression(target) || target.getName() !== "$accelerate") continue;
      const statement = standaloneStatement(call);
      const edit: SourceEdit = {
        finding: finding(file, call, {
          rule: "cache-invalidate",
          severity: "action",
          fix: statement ? "drop-cache" : "manual",
          message: statement
            ? `$accelerate.${name}() has nothing to invalidate once Accelerate is gone. --drop-cache removes the statement.`
            : `$accelerate.${name}() is used as a value. Rewrite this expression by hand.`,
        }),
        edits: statement ? [removeNode(statement)] : [],
      };
      result.findings.push(edit.finding);
      if (statement) result.cacheEdits.push(edit);
      else block(call, `$accelerate.${name}() used as a value`);
    }
  }

  return result;
}
