import ts, { factory } from "typescript";
import { TypeGuardGenerator } from "./generator";
import { assert, unimplemented } from "./helpers";
import { TypeModel, symbolToModel } from "./model";
import { TypeScriptError } from "./errors";

/**
 * This is required for both `X[]` and `Array<X>` to work properly.
 * Otherwise `checker.isArrayType()` is not gonna work.
 */
const libFileContent = `/// <reference no-default-lib="true"/>
interface Boolean {}
interface Function {}
interface CallableFunction {}
interface NewableFunction {}
interface IArguments {}
interface Number { toExponential: any; }
interface Object {}
interface RegExp {}
interface String { charAt: any; }
interface Array<T> { length: number; [n: number]: T; }
interface ReadonlyArray<T> {}
declare const console: { log(msg: any): void; };`;

export function newVFSProgram(source: string): ts.Program {
  const fileName = "/source.ts";

  const files = new Map<string, string>();
  files.set(fileName, source);

  const libFileName = "/lib/lib.d.ts";
  files.set(libFileName, libFileContent);

  const compilerHost: ts.CompilerHost = {
    fileExists: (fileName) => files.has(fileName),
    getSourceFile: (fileName, options) => {
      const content = files.get(fileName);
      assert(content != undefined, "source files cannot be missing");
      return ts.createSourceFile(fileName, content, options);
    },
    getDefaultLibFileName: () => "/lib/lib.d.ts",
    writeFile: unimplemented,
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    getCanonicalFileName: (f) => f.toLowerCase(),
    getNewLine: () => "\n",
    useCaseSensitiveFileNames: () => false,
    readFile: (path) => files.get(path),
  };

  return ts.createProgram(
    [fileName],
    {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      strict: true,
      noEmit: true,
      isolatedModules: true,
      // don't autoload all the types from the node_modules/@types
      types: [],
    },
    compilerHost
  );
}

export function ensureNoErrors(program: ts.Program) {
  const allDiagnostics = ts.getPreEmitDiagnostics(program);
  if (allDiagnostics.length != 0) {
    allDiagnostics.forEach((diagnostic) => {
      var message = ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        "\n"
      );
      if (!diagnostic.file) {
        console.error(message);
        return;
      }
      var { line, character } =
        diagnostic.file.getLineAndCharacterOfPosition(
          diagnostic.start!
        );
      console.error(
        `${diagnostic.file.fileName} (${line + 1},${
          character + 1
        }): ${message}`
      );
    });

    throw new TypeScriptError(
      "ts.getPreEmitDiagnostics() found some issues listed in the console / stderr"
    );
  }
}

function hasExportModifier(
  node:
    | ts.TypeAliasDeclaration
    | ts.InterfaceDeclaration
    | ts.EnumDeclaration
): boolean {
  return (
    node.modifiers?.some(
      (node) => node.kind === ts.SyntaxKind.ExportKeyword
    ) ?? false
  );
}

export function sourceFileToDeclarationSymbols(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile
): ts.Symbol[] {
  const symbols: ts.Symbol[] = [];

  // Walk the tree to search for types
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isExportDeclaration(node)) {
      const exportClause = node.exportClause;
      if (exportClause && ts.isNamedExports(exportClause)) {
        for (const es of exportClause.elements) {
          if (es.isTypeOnly) {
            const symbol = checker.getSymbolAtLocation(es.name);
            assert(
              symbol,
              "an export declaration must have a symbol"
            );
            symbols.push(symbol);
          }
        }
      }
    }
    if (
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (!hasExportModifier(node)) return;
      const symbol = checker.getSymbolAtLocation(node.name);
      assert(symbol, "a node declaration must have a symbol");
      symbols.push(symbol);
    }
  });

  return symbols;
}

export function symbolsToModels(
  checker: ts.TypeChecker,
  symbols: ts.Symbol[]
): TypeModel[] {
  return symbols.map((symbol) => symbolToModel(checker, symbol));
}

export function sourceFileToModels(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile
): TypeModel[] {
  return symbolsToModels(
    checker,
    sourceFileToDeclarationSymbols(checker, sourceFile)
  );
}

export function nodesToString(
  fileName: string,
  nodes: ts.Statement[]
): string {
  const resultFile = factory.updateSourceFile(
    ts.createSourceFile(
      fileName,
      "",
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ false,
      ts.ScriptKind.TS
    ),
    nodes
  );

  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
  });
  return printer.printFile(resultFile);
}
